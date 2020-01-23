'use strict';

const crypto = require('crypto');
const defaultConfig = require('./defaults/config');
const BaseModule = require('lisk-framework/src/modules/base_module');
const { createStorageComponent } = require('lisk-framework/src/components/storage');
const { createLoggerComponent } = require('lisk-framework/src/components/logger');
const TradeEngine = require('./trade-engine');
const liskCryptography = require('@liskhq/lisk-cryptography');
const { getAddressFromPublicKey } = liskCryptography;
const liskTransactions = require('@liskhq/lisk-transactions');
const fs = require('fs');
const util = require('util');
const path = require('path');
const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const unlink = util.promisify(fs.unlink);
const mkdir = util.promisify(fs.mkdir);

const WritableConsumableStream = require('writable-consumable-stream');

const MODULE_ALIAS = 'lisk_dex';
const { LISK_DEX_PASSWORD } = process.env;
const CIPHER_ALGORITHM = 'aes-192-cbc';
const CIPHER_KEY = LISK_DEX_PASSWORD ? crypto.scryptSync(LISK_DEX_PASSWORD, 'salt', 24) : undefined;
const CIPHER_IV = Buffer.alloc(16, 0);

const DEFAULT_SIGNATURE_BROADCAST_DELAY = 15000;
const DEFAULT_TRANSACTION_SUBMIT_DELAY = 5000;

/**
 * Lisk DEX module specification
 *
 * @namespace Framework.Modules
 * @type {module.LiskDEXModule}
 */
module.exports = class LiskDEXModule extends BaseModule {
  constructor(options) {
    super({...defaultConfig, ...options});
    this.chainSymbols = Object.keys(this.options.chains);
    if (this.chainSymbols.length !== 2) {
      throw new Error('The DEX module must operate only on 2 chains');
    }
    this.multisigWalletInfo = {};
    this.isForked = false;
    this.lastSnapshot = null;
    this.pendingTransfers = new Map();
    this.chainSymbols.forEach((chainSymbol) => {
      this.multisigWalletInfo[chainSymbol] = {
        members: {},
        memberCount: 0,
        requiredSignatureCount: null
      };
    });

    this.passiveMode = this.options.passiveMode;
    this.baseChainSymbol = this.options.baseChain;
    this.quoteChainSymbol = this.chainSymbols.find(chain => chain !== this.baseChainSymbol);
    let baseChainOptions = this.options.chains[this.baseChainSymbol];
    let quoteChainOptions = this.options.chains[this.quoteChainSymbol];
    this.baseAddress = baseChainOptions.walletAddress;
    this.quoteAddress = quoteChainOptions.walletAddress;
    this.tradeEngine = new TradeEngine({
      baseCurrency: this.baseChainSymbol,
      quoteCurrency: this.quoteChainSymbol,
      baseOrderHeightExpiry: baseChainOptions.orderHeightExpiry,
      quoteOrderHeightExpiry: quoteChainOptions.orderHeightExpiry
    });

    this.chainSymbols.forEach((chainSymbol) => {
      let chainOptions = this.options.chains[chainSymbol];
      if (chainOptions.encryptedPassphrase) {
        if (!LISK_DEX_PASSWORD) {
          throw new Error(
            `Cannot decrypt the encryptedPassphrase from the ${
              MODULE_ALIAS
            } config for the ${
              chainSymbol
            } chain without a valid LISK_DEX_PASSWORD environment variable`
          );
        }
        if (chainOptions.passphrase) {
          throw new Error(
            `The ${
              MODULE_ALIAS
            } config for the ${
              chainSymbol
            } chain should have either a passphrase or encryptedPassphrase but not both`
          );
        }
        try {
          let decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, CIPHER_KEY, CIPHER_IV);
          let decrypted = decipher.update(chainOptions.encryptedPassphrase, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          chainOptions.passphrase = decrypted;
        } catch (error) {
          throw new Error(
            `Failed to decrypt encryptedPassphrase in ${
              MODULE_ALIAS
            } config for chain ${
              chainSymbol
            } - Check that the LISK_DEX_PASSWORD environment variable is correct`
          );
        }
      }
      if (chainOptions.encryptedSharedPassphrase) {
        if (!LISK_DEX_PASSWORD) {
          throw new Error(
            `Cannot decrypt the encryptedSharedPassphrase from the ${
              MODULE_ALIAS
            } config for the ${
              chainSymbol
            } chain without a valid LISK_DEX_PASSWORD environment variable`
          );
        }
        if (chainOptions.sharedPassphrase) {
          throw new Error(
            `The ${
              MODULE_ALIAS
            } config for the ${
              chainSymbol
            } chain should have either a sharedPassphrase or encryptedSharedPassphrase but not both`
          );
        }
        try {
          let decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, CIPHER_KEY, CIPHER_IV);
          let decrypted = decipher.update(chainOptions.encryptedSharedPassphrase, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          chainOptions.sharedPassphrase = decrypted;
        } catch (error) {
          throw new Error(
            `Failed to decrypt encryptedSharedPassphrase in ${
              MODULE_ALIAS
            } config for chain ${
              chainSymbol
            } - Check that the LISK_DEX_PASSWORD environment variable is correct`
          );
        }
      }
    });

    if (this.options.dividendFunction) {
      this.dividendFunction = this.options.dividendFunction;
    } else {
      this.dividendFunction = (chainSymbol, contributionData, chainOptions, memberCount) => {
        return Object.keys(contributionData).map((walletAddress) => {
          let payableContribution = contributionData[walletAddress] * chainOptions.dividendRate;
          return {
            walletAddress,
            amount: Math.floor(payableContribution * chainOptions.exchangeFeeRate / memberCount)
          };
        });
      };
    }
  }

  static get alias() {
    return MODULE_ALIAS;
  }

  static get info() {
    return {
      author: 'Jonathan Gros-Dubois',
      version: '1.0.0',
      name: MODULE_ALIAS,
    };
  }

  static get migrations() {
    return [];
  }

  static get defaults() {
    return defaultConfig;
  }

  _execQueryAgainstIterator(query, sourceIterator, idExtractorFn) {
    query = query || {};
    let {after, before, limit, sort, ...filterMap} = query;
    let filterFields = Object.keys(filterMap);
    if (filterFields.length > this.options.apiMaxFilterFields) {
      let error = new Error(
        `Too many custom filter fields were specified in the query. The maximum allowed is ${
          this.options.apiMaxFilterFields
        }`
      );
      error.name = 'InvalidQueryError';
      throw error;
    }
    if (limit == null) {
      limit = this.options.apiDefaultPageLimit;
    }
    if (typeof limit !== 'number') {
      let error = new Error(
        'If specified, the limit parameter of the query must be a number'
      );
      error.name = 'InvalidQueryError';
      throw error;
    }
    if (limit > this.options.apiMaxPageLimit) {
      let error = new Error(
        `The limit parameter of the query cannot be greater than ${
          this.options.apiMaxPageLimit
        }`
      );
      error.name = 'InvalidQueryError';
      throw error;
    }
    let [sortField, sortOrderString] = (sort || '').split(':');
    if (sortOrderString != null && sortOrderString !== 'asc' && sortOrderString !== 'desc') {
      let error = new Error(
        'If specified, the sort order must be either asc or desc'
      );
      error.name = 'InvalidQueryError';
      throw error;
    }
    let sortOrder = sortOrderString === 'desc' ? -1 : 1;
    let iterator;
    if (sortField) {
      let list = [...sourceIterator];
      list.sort((a, b) => {
        let valueA = a[sortField];
        let valueB = b[sortField];
        if (valueA > valueB) {
          return sortOrder;
        }
        if (valueA < valueB) {
          return -sortOrder;
        }
        return 0;
      });
      iterator = list;
    } else {
      iterator = sourceIterator;
    }

    let result = [];
    if (after) {
      let isCapturing = false;
      for (let item of iterator) {
        if (isCapturing) {
          let itemMatchesFilter = filterFields.every(
            (field) => String(item[field]) === String(filterMap[field])
          );
          if (itemMatchesFilter) {
            result.push(item);
          }
        } else if (idExtractorFn(item) === after) {
          isCapturing = true;
        }
        if (result.length >= limit) {
          break;
        }
      }
      return result;
    }
    if (before) {
      let previousItems = [];
      for (let item of iterator) {
        if (idExtractorFn(item) === before) {
          let length = previousItems.length;
          let firstIndex = length - limit;
          if (firstIndex < 0) {
            firstIndex = 0;
          }
          result = previousItems.slice(firstIndex, length);
          break;
        }
        let itemMatchesFilter = filterFields.every(
          (field) => String(item[field]) === String(filterMap[field])
        );
        if (itemMatchesFilter) {
          previousItems.push(item);
        }
      }
      return result;
    }
    for (let item of iterator) {
      let itemMatchesFilter = filterFields.every(
        (field) => String(item[field]) === String(filterMap[field])
      );
      if (itemMatchesFilter) {
        result.push(item);
      }
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  get events() {
    return [
      'bootstrap',
    ];
  }

  get actions() {
    return {
      getMarket: {
        handler: () => {
          return {
            baseSymbol: this.baseChainSymbol,
            quoteSymbol: this.quoteChainSymbol
          };
        }
      },
      getBids: {
        handler: (action) => {
          let bidIterator = this.tradeEngine.getBidIterator();
          return this._execQueryAgainstIterator(action.params, bidIterator, (item) => item.id);
        }
      },
      getAsks: {
        handler: (action) => {
          let askIterator = this.tradeEngine.getAskIterator();
          return this._execQueryAgainstIterator(action.params, askIterator, (item) => item.id);
        }
      },
      getOrders: {
        handler: (action) => {
          let orderIterator = this.tradeEngine.getOrderIterator();
          return this._execQueryAgainstIterator(action.params, orderIterator, (item) => item.id);
        }
      },
      getPendingTransfers: {
        handler: (action) => {
          let transferList = this._execQueryAgainstIterator(
            action.params,
            this.pendingTransfers.values(),
            (item) => item.transaction.id
          );
          return transferList.map((transfer) => ({
            transaction: transfer.transaction,
            targetChain: transfer.targetChain,
            collectedSignatures: [...transfer.processedSignatureSet.values()],
            contributors: [...transfer.contributors],
            timestamp: transfer.timestamp
          }));
        }
      }
    };
  }

  _getSignatureQuota(targetChain, transaction) {
    return transaction.signatures.length - (this.multisigWalletInfo[targetChain] || {}).requiredSignatureCount;
  }

  _verifySignature(targetChain, publicKey, transaction, signatureToVerify) {
    let isValidMemberSignature = this.multisigWalletInfo[targetChain].members[publicKey];
    if (!isValidMemberSignature) {
      return false;
    }
    let {signature, signSignature, ...transactionToHash} = transaction;
    let txnHash = liskCryptography.hash(liskTransactions.utils.getTransactionBytes(transactionToHash));
    return liskCryptography.verifyData(txnHash, signatureToVerify, publicKey);
  }

  _processSignature(signatureData) {
    let transactionData = this.pendingTransfers.get(signatureData.transactionId);
    let signature = signatureData.signature;
    let publicKey = signatureData.publicKey;
    if (!transactionData) {
      return {
        isAccepted: false,
        targetChain: null,
        transaction: null,
        signature,
        publicKey
      };
    }
    let {transaction, processedSignatureSet, contributors, targetChain} = transactionData;
    if (processedSignatureSet.has(signature)) {
      return {
        isAccepted: false,
        targetChain,
        transaction,
        signature,
        publicKey
      };
    }

    let isValidSignature = this._verifySignature(targetChain, publicKey, transaction, signature);
    if (!isValidSignature) {
      return {
        isAccepted: false,
        targetChain,
        transaction,
        signature,
        publicKey
      };
    }

    processedSignatureSet.add(signature);
    transaction.signatures.push(signature);

    let memberAddress = getAddressFromPublicKey(publicKey);
    contributors.add(memberAddress);

    let signatureQuota = this._getSignatureQuota(targetChain, transaction);
    if (signatureQuota >= 0) {
      transactionData.isReady = true;
    }

    return {
      signatureQuota,
      isAccepted: true,
      targetChain,
      transaction,
      signature,
      publicKey
    };
  }

  expireMultisigTransactions() {
    let now = Date.now();
    for (let [txnId, txnData] of this.pendingTransfers) {
      if (now - txnData.timestamp < this.options.multisigExpiry) {
        break;
      }
      this.pendingTransfers.delete(txnId);
    }
  }

  async _postTransactionToChain(targetChain, transaction) {
    let chainOptions = this.options.chains[targetChain];
    if (chainOptions && chainOptions.moduleAlias) {
      let postTxnResult;
      try {
        postTxnResult = await this.channel.invoke(
          `${chainOptions.moduleAlias}:postTransaction`,
          {transaction}
        );
      } catch (error) {
        this.logger.error(
          `Error encountered while attempting to invoke ${chainOptions.moduleAlias}:postTransaction action - ${error.message}`
        );
        return;
      }
      if (!postTxnResult.success) {
        this.logger.error(
          `Failed to process ${chainOptions.moduleAlias}:postTransaction action - ${postTxnResult.message}`
        );
      }
    }
  }

  async load(channel) {
    this.channel = channel;

    this._multisigExpiryInterval = setInterval(() => {
      this.expireMultisigTransactions();
    }, this.options.multisigExpiryCheckInterval);

    await this.channel.invoke('interchain:updateModuleState', {
      lisk_dex: {
        baseAddress: this.baseAddress,
        quoteAddress: this.quoteAddress
      }
    });

    this.channel.subscribe('network:event', async (payload) => {
      if (!payload) {
        payload = {};
      }
      let {event, data} = payload.data || {};
      if (event === `${MODULE_ALIAS}:signature`) {
        let signatureData = data || {};
        let result = this._processSignature(signatureData);

        if (result.isAccepted) {
          // Propagate valid signature to peers who are members of the DEX subnet.
          await this._broadcastSignatureToSubnet(result.transaction.id, result.signature, result.publicKey);

          if (result.signatureQuota === 0) {
            let txnSubmitDelay = this.options.transactionSubmitDelay == null ?
              DEFAULT_TRANSACTION_SUBMIT_DELAY : this.options.transactionSubmitDelay;
            // Wait some additional time to collect signatures from remaining DEX members.
            // The signatures will keep accumulating in the transaction object's signatures array.
            await wait(txnSubmitDelay);
            await this._postTransactionToChain(result.targetChain, result.transaction);
          }
        }
        return;
      }
    });

    let loggerConfig = await channel.invoke(
      'app:getComponentConfig',
      'logger',
    );
    this.logger = createLoggerComponent({...loggerConfig, ...this.options.logger});

    try {
      await mkdir(this.options.orderBookSnapshotBackupDirPath);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        this.logger.error(
          `Failed to create snapshot directory ${
            this.options.orderBookSnapshotBackupDirPath
          } because of error: ${
            error.message
          }`
        );
      }
    }

    let storageConfigOptions = await channel.invoke(
      'app:getComponentConfig',
      'storage',
    );

    this._storageComponents = {};

    await Promise.all(
      this.chainSymbols.map(async (chainSymbol) => {
        let chainOptions = this.options.chains[chainSymbol];
        let storageConfig = {
          ...storageConfigOptions,
          database: chainOptions.database,
        };
        let storage = createStorageComponent(storageConfig, this.logger);
        await storage.bootstrap();
        this._storageComponents[chainSymbol] = storage;

        // TODO: When it becomes possible, use internal module API (using channel.invoke) to get this data instead of direct DB access.
        let multisigMemberRows = await storage.adapter.db.query(
          'select mem_accounts2multisignatures."dependentId" from mem_accounts2multisignatures where mem_accounts2multisignatures."accountId" = $1',
          [chainOptions.walletAddress],
        );

        multisigMemberRows.forEach((row) => {
          this.multisigWalletInfo[chainSymbol].members[row.dependentId] = true;
        });
        this.multisigWalletInfo[chainSymbol].memberCount = multisigMemberRows.length;

        let multisigMemberMinSigRows = await storage.adapter.db.query(
          'select multimin from mem_accounts where address = $1',
          [chainOptions.walletAddress],
        );

        multisigMemberMinSigRows.forEach((row) => {
          this.multisigWalletInfo[chainSymbol].requiredSignatureCount = Number(row.multimin);
        });
      })
    );

    let lastProcessedTimestamp = null;
    try {
      lastProcessedTimestamp = await this.loadSnapshot();
    } catch (error) {
      this.logger.error(
        `Failed to load initial snapshot because of error: ${error.message} - DEX node will start with an empty order book`
      );
    }

    let dividendProcessingStream = new WritableConsumableStream();

    let processBlock = async ({chainSymbol, chainHeight, latestChainHeights, isLastBlock, blockData}) => {
      let storage = this._storageComponents[chainSymbol];
      let chainOptions = this.options.chains[chainSymbol];

      let targetHeight = chainHeight - chainOptions.requiredConfirmations;
      let minOrderAmount = chainOptions.minOrderAmount;

      // If we are on the latest height (or latest height in a batch), rebroadcast our
      // node's signature for each pending multisig transaction in case other DEX nodes
      // did not receive it.
      if (isLastBlock) {
        for (let transfer of this.pendingTransfers.values()) {
          if (transfer.targetChain !== chainSymbol) {
            continue;
          }
          let heightDiff = targetHeight - transfer.height;
          if (
            heightDiff > chainOptions.rebroadcastAfterHeight &&
            heightDiff < chainOptions.rebroadcastUntilHeight &&
            transfer.transaction.signatures.length
          ) {
            if (transfer.isReady) {
              this._postTransactionToChain(transfer.targetChain, transfer.transaction);
            } else {
              this._broadcastSignatureToSubnet(
                transfer.transaction.id,
                transfer.transaction.signatures[0],
                transfer.publicKey
              );
            }
          }
        }
      }

      this.logger.trace(
        `Chain ${chainSymbol}: Processing block at height ${targetHeight}`
      );

      let latestBlockTimestamp = blockData.timestamp;

      if (!blockData.numberOfTransactions) {
        this.logger.trace(
          `Chain ${chainSymbol}: No transactions in block ${blockData.id} at height ${targetHeight}`
        );
      }

      // The height pointer for dividends needs to be delayed so that DEX member dividends are only distributed
      // when there is no risk of fork in the underlying blockchain.
      let dividendTargetHeight = targetHeight - chainOptions.dividendHeightOffset;
      if (
        dividendTargetHeight > chainOptions.dividendStartHeight &&
        dividendTargetHeight % chainOptions.dividendHeightInterval === 0
      ) {
        dividendProcessingStream.write({
          chainSymbol,
          chainHeight: targetHeight,
          toHeight: dividendTargetHeight,
          latestBlockTimestamp
        });
      }

      let blockTransactions = await Promise.all([
        this._getInboundTransactions(storage, blockData.id, chainOptions.walletAddress),
        this._getOutboundTransactions(storage, blockData.id, chainOptions.walletAddress)
      ]);

      let [inboundTxns, outboundTxns] = blockTransactions;

      outboundTxns.forEach((txn) => {
        this.pendingTransfers.delete(txn.id);
      });

      let orders = inboundTxns.map((txn) => {
        let orderTxn = {...txn};
        orderTxn.sourceChain = chainSymbol;
        orderTxn.sourceWalletAddress = orderTxn.senderId;
        let amount = parseInt(orderTxn.amount);

        if (amount > Number.MAX_SAFE_INTEGER) {
          orderTxn.type = 'oversized';
          orderTxn.sourceChainAmount = BigInt(orderTxn.amount);
          this.logger.debug(
            `Chain ${chainSymbol}: Incoming order ${orderTxn.id} amount ${orderTxn.sourceChainAmount.toString()} was too large - Maximum order amount is ${Number.MAX_SAFE_INTEGER}`
          );
          return orderTxn;
        }

        orderTxn.sourceChainAmount = amount;

        if (
          chainOptions.dexDisabledFromHeight != null &&
          targetHeight >= chainOptions.dexDisabledFromHeight
        ) {
          if (chainOptions.dexMovedToAddress) {
            orderTxn.type = 'moved';
            orderTxn.movedToAddress = chainOptions.dexMovedToAddress;
            this.logger.debug(
              `Chain ${chainSymbol}: Cannot process order ${orderTxn.id} because the DEX has moved to the address ${chainOptions.dexMovedToAddress}`
            );
            return orderTxn;
          }
          orderTxn.type = 'disabled';
          this.logger.debug(
            `Chain ${chainSymbol}: Cannot process order ${orderTxn.id} because the DEX has been disabled`
          );
          return orderTxn;
        }

        let transferDataString = txn.transferData == null ? '' : txn.transferData.toString('utf8');
        let dataParts = transferDataString.split(',');

        let targetChain = dataParts[0];
        orderTxn.targetChain = targetChain;
        let isSupportedChain = this.options.chains[targetChain] && targetChain !== chainSymbol;
        if (!isSupportedChain) {
          orderTxn.type = 'invalid';
          orderTxn.reason = 'Invalid target chain';
          this.logger.debug(
            `Chain ${chainSymbol}: Incoming order ${orderTxn.id} has an invalid target chain ${targetChain}`
          );
          return orderTxn;
        }

        if (
          (dataParts[1] === 'limit' || dataParts[1] === 'market') &&
          amount < minOrderAmount
        ) {
          orderTxn.type = 'undersized';
          this.logger.debug(
            `Chain ${chainSymbol}: Incoming order ${orderTxn.id} amount ${orderTxn.sourceChainAmount.toString()} was too small - Minimum order amount is ${minOrderAmount}`
          );
          return orderTxn;
        }

        if (dataParts[1] === 'limit') {
          // E.g. clsk,limit,.5,9205805648791671841L
          let price = Number(dataParts[2]);
          let targetWalletAddress = dataParts[3];
          if (isNaN(price)) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Invalid price';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming limit order ${orderTxn.id} has an invalid price`
            );
            return orderTxn;
          }
          if (!targetWalletAddress) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Invalid wallet address';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming limit order ${orderTxn.id} has an invalid wallet address`
            );
            return orderTxn;
          }
          if (this._isLimitOrderTooSmallToConvert(chainSymbol, amount, price)) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Too small to convert';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming limit order ${orderTxn.id} was too small to cover base blockchain fees`
            );
            return orderTxn;
          }

          orderTxn.type = 'limit';
          orderTxn.height = targetHeight;
          orderTxn.price = price;
          orderTxn.targetWalletAddress = targetWalletAddress;
          if (chainSymbol === this.baseChainSymbol) {
            orderTxn.side = 'bid';
            orderTxn.value = amount;
          } else {
            orderTxn.side = 'ask';
            orderTxn.size = amount;
          }
        } else if (dataParts[1] === 'market') {
          // E.g. clsk,market,9205805648791671841L
          let targetWalletAddress = dataParts[2];
          if (!targetWalletAddress) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Invalid wallet address';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming market order ${orderTxn.id} has an invalid wallet address`
            );
            return orderTxn;
          }
          if (this._isMarketOrderTooSmallToConvert(chainSymbol, amount)) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Too small to convert';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming market order ${orderTxn.id} was too small to cover base blockchain fees`
            );
            return orderTxn;
          }
          orderTxn.type = 'market';
          orderTxn.height = targetHeight;
          orderTxn.targetWalletAddress = targetWalletAddress;
          if (chainSymbol === this.baseChainSymbol) {
            orderTxn.side = 'bid';
            orderTxn.value = amount;
          } else {
            orderTxn.side = 'ask';
            orderTxn.size = amount;
          }
        } else if (dataParts[1] === 'close') {
          // E.g. clsk,close,1787318409505302601
          let targetOrderId = dataParts[2];
          if (!targetOrderId) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Missing order ID';
            this.logger.debug(
              `Chain ${chainSymbol}: Incoming close order ${orderTxn.id} is missing an order ID`
            );
            return orderTxn;
          }
          let targetOrder = this.tradeEngine.getOrder(targetOrderId);
          if (!targetOrder) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Invalid order ID';
            this.logger.error(
              `Chain ${chainSymbol}: Failed to close order with ID ${targetOrderId} because it could not be found`
            );
            return orderTxn;
          }
          if (targetOrder.sourceChain !== orderTxn.sourceChain) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Wrong chain';
            this.logger.error(
              `Chain ${chainSymbol}: Could not close order ID ${targetOrderId} because it is on a different chain`
            );
            return orderTxn;
          }
          if (targetOrder.sourceWalletAddress !== orderTxn.sourceWalletAddress) {
            orderTxn.type = 'invalid';
            orderTxn.reason = 'Not authorized';
            this.logger.error(
              `Chain ${chainSymbol}: Could not close order ID ${targetOrderId} because it belongs to a different account`
            );
            return orderTxn;
          }
          orderTxn.type = 'close';
          orderTxn.height = targetHeight;
          orderTxn.orderIdToClose = targetOrderId;
        } else {
          orderTxn.type = 'invalid';
          orderTxn.reason = 'Invalid operation';
          this.logger.debug(
            `Chain ${chainSymbol}: Incoming transaction ${orderTxn.id} is not a supported DEX order`
          );
        }
        return orderTxn;
      });

      let closeOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'close';
      });

      let limitAndMarketOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'limit' || orderTxn.type === 'market';
      });

      let invalidOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'invalid';
      });

      let oversizedOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'oversized';
      });

      let undersizedOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'undersized';
      });

      let movedOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'moved';
      });

      let disabledOrders = orders.filter((orderTxn) => {
        return orderTxn.type === 'disabled';
      });

      if (!this.passiveMode) {
        await Promise.all(
          movedOrders.map(async (orderTxn) => {
            try {
              await this.execRefundTransaction(orderTxn, latestBlockTimestamp, `r5,${orderTxn.id},${orderTxn.movedToAddress}: DEX has moved`);
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig refund transaction for moved DEX order ID ${
                  orderTxn.id
                } to ${
                  orderTxn.sourceWalletAddress
                } on chain ${
                  orderTxn.sourceChain
                } because of error: ${
                  error.message
                }`
              );
            }
          })
        );

        await Promise.all(
          disabledOrders.map(async (orderTxn) => {
            try {
              await this.execRefundTransaction(orderTxn, latestBlockTimestamp, `r6,${orderTxn.id}: DEX has been disabled`);
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig refund transaction for disabled DEX order ID ${
                  orderTxn.id
                } to ${
                  orderTxn.sourceWalletAddress
                } on chain ${
                  orderTxn.sourceChain
                } because of error: ${
                  error.message
                }`
              );
            }
          })
        );

        await Promise.all(
          invalidOrders.map(async (orderTxn) => {
            let reasonMessage = 'Invalid order';
            if (orderTxn.reason) {
              reasonMessage += ` - ${orderTxn.reason}`;
            }
            try {
              await this.execRefundTransaction(orderTxn, latestBlockTimestamp, `r1,${orderTxn.id}: ${reasonMessage}`);
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig refund transaction for invalid order ID ${
                  orderTxn.id
                } to ${
                  orderTxn.sourceWalletAddress
                } on chain ${
                  orderTxn.sourceChain
                } because of error: ${
                  error.message
                }`
              );
            }
          })
        );

        await Promise.all(
          oversizedOrders.map(async (orderTxn) => {
            try {
              await this.execRefundTransaction(orderTxn, latestBlockTimestamp, `r1,${orderTxn.id}: Oversized order`);
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig refund transaction for oversized order ID ${
                  orderTxn.id
                } to ${
                  orderTxn.sourceWalletAddress
                } on chain ${
                  orderTxn.sourceChain
                } because of error: ${
                  error.message
                }`
              );
            }
          })
        );

        await Promise.all(
          undersizedOrders.map(async (orderTxn) => {
            try {
              await this.execRefundTransaction(orderTxn, latestBlockTimestamp, `r1,${orderTxn.id}: Undersized order`);
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig refund transaction for undersized order ID ${
                  orderTxn.id
                } to ${
                  orderTxn.sourceWalletAddress
                } on chain ${
                  orderTxn.sourceChain
                } because of error: ${
                  error.message
                }`
              );
            }
          })
        );
      }

      let expiredOrders;
      if (chainSymbol === this.baseChainSymbol) {
        expiredOrders = this.tradeEngine.expireBidOrders(targetHeight);
      } else {
        expiredOrders = this.tradeEngine.expireAskOrders(targetHeight);
      }
      expiredOrders.forEach(async (expiredOrder) => {
        this.logger.trace(
          `Chain ${chainSymbol}: Order ${expiredOrder.id} at height ${expiredOrder.height} expired`
        );
        if (this.passiveMode) {
          return;
        }
        let refundTimestamp;
        if (expiredOrder.expiryHeight === targetHeight) {
          refundTimestamp = latestBlockTimestamp;
        } else {
          try {
            let expiryBlock = await this._getBlockAtHeight(storage, expiredOrder.expiryHeight);
            if (!expiryBlock) {
              throw new Error(
                `No block found at height ${expiredOrder.expiryHeight}`
              );
            }
            refundTimestamp = expiryBlock.timestamp;
          } catch (error) {
            this.logger.error(
              `Chain ${chainSymbol}: Failed to create multisig refund transaction for expired order ID ${
                expiredOrder.id
              } to ${
                expiredOrder.sourceWalletAddress
              } on chain ${
                expiredOrder.sourceChain
              } because it could not calculate the timestamp due to error: ${
                error.message
              }`
            );
            return;
          }
        }
        try {
          await this.refundOrder(
            expiredOrder,
            refundTimestamp,
            expiredOrder.expiryHeight,
            `r2,${expiredOrder.id}: Expired order`
          );
        } catch (error) {
          this.logger.error(
            `Chain ${chainSymbol}: Failed to post multisig refund transaction for expired order ID ${
              expiredOrder.id
            } to ${
              expiredOrder.sourceWalletAddress
            } on chain ${
              expiredOrder.sourceChain
            } because of error: ${
              error.message
            }`
          );
        }
      });

      await Promise.all(
        closeOrders.map(async (orderTxn) => {
          let targetOrder = this.tradeEngine.getOrder(orderTxn.orderIdToClose);
          let refundTxn = {
            sourceChain: targetOrder.sourceChain,
            sourceWalletAddress: targetOrder.sourceWalletAddress,
            height: orderTxn.height
          };
          if (refundTxn.sourceChain === this.baseChainSymbol) {
            refundTxn.sourceChainAmount = targetOrder.valueRemaining;
          } else {
            refundTxn.sourceChainAmount = targetOrder.sizeRemaining;
          }
          // Also send back any amount which was sent as part of the close order.
          refundTxn.sourceChainAmount += orderTxn.sourceChainAmount;

          let result;
          try {
            result = this.tradeEngine.closeOrder(orderTxn.orderIdToClose);
          } catch (error) {
            this.logger.error(error);
            return;
          }
          if (this.passiveMode) {
            return;
          }
          try {
            await this.execRefundTransaction(refundTxn, latestBlockTimestamp, `r3,${targetOrder.id},${orderTxn.id}: Closed order`);
          } catch (error) {
            this.logger.error(
              `Chain ${chainSymbol}: Failed to post multisig refund transaction for closed order ID ${
                targetOrder.id
              } to ${
                targetOrder.sourceWalletAddress
              } on chain ${
                targetOrder.sourceChain
              } because of error: ${
                error.message
              }`
            );
          }
        })
      );

      await Promise.all(
        limitAndMarketOrders.map(async (orderTxn) => {
          let result;
          try {
            result = this.tradeEngine.addOrder(orderTxn);
          } catch (error) {
            this.logger.error(error);
            return;
          }

          if (result.takeSize <= 0) {
            return;
          }

          let takerTargetChain = result.taker.targetChain;
          let takerChainOptions = this.options.chains[takerTargetChain];
          let takerTargetChainModuleAlias = takerChainOptions.moduleAlias;
          let takerAddress = result.taker.targetWalletAddress;
          let takerAmount = takerTargetChain === this.baseChainSymbol ? result.takeValue : result.takeSize;
          takerAmount -= takerChainOptions.exchangeFeeBase;
          takerAmount -= takerAmount * takerChainOptions.exchangeFeeRate;
          takerAmount = Math.floor(takerAmount);

          if (this.passiveMode) {
            return;
          }

          if (takerAmount <= 0) {
            this.logger.error(
              `Chain ${chainSymbol}: Failed to post the taker trade order ${orderTxn.id} because the amount after fees was less than or equal to 0`
            );
            return;
          }

          (async () => {
            let takerTxn = {
              amount: takerAmount.toString(),
              recipientId: takerAddress,
              height: latestChainHeights[takerTargetChain],
              timestamp: orderTxn.timestamp + 1
            };
            try {
              await this.execMultisigTransaction(
                takerTargetChain,
                takerTxn,
                `t1,${result.taker.sourceChain},${result.taker.id}: Orders taken`
              );
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig transaction of taker ${takerAddress} on chain ${takerTargetChain} because of error: ${error.message}`
              );
            }
          })();

          (async () => {
            if (orderTxn.type === 'market') {
              let refundTxn = {
                sourceChain: result.taker.sourceChain,
                sourceWalletAddress: result.taker.sourceWalletAddress,
                height: orderTxn.height
              };
              if (result.taker.sourceChain === this.baseChainSymbol) {
                refundTxn.sourceChainAmount = result.taker.valueRemaining;
              } else {
                refundTxn.sourceChainAmount = result.taker.sizeRemaining;
              }
              if (refundTxn.sourceChainAmount <= 0) {
                return;
              }
              try {
                await this.execRefundTransaction(refundTxn, latestBlockTimestamp, `r4,${orderTxn.id}: Unmatched market order part`);
              } catch (error) {
                this.logger.error(
                  `Chain ${chainSymbol}: Failed to post multisig market order refund transaction of taker ${takerAddress} on chain ${takerTargetChain} because of error: ${error.message}`
                );
              }
            }
          })();

          await Promise.all(
            result.makers.map(async (makerOrder) => {
              let makerChainOptions = this.options.chains[makerOrder.targetChain];
              let makerTargetChainModuleAlias = makerChainOptions.moduleAlias;
              let makerAddress = makerOrder.targetWalletAddress;
              let makerAmount = makerOrder.targetChain === this.baseChainSymbol ? makerOrder.lastValueTaken : makerOrder.lastSizeTaken;
              makerAmount -= makerChainOptions.exchangeFeeBase;
              makerAmount -= makerAmount * makerChainOptions.exchangeFeeRate;
              makerAmount = Math.floor(makerAmount);

              if (makerAmount <= 0) {
                this.logger.error(
                  `Chain ${chainSymbol}: Failed to post the maker trade order ${makerOrder.id} because the amount after fees was less than or equal to 0`
                );
                return;
              }

              (async () => {
                let makerTxn = {
                  amount: makerAmount.toString(),
                  recipientId: makerAddress,
                  height: latestChainHeights[makerOrder.targetChain],
                  timestamp: orderTxn.timestamp + 1
                };
                try {
                  await this.execMultisigTransaction(
                    makerOrder.targetChain,
                    makerTxn,
                    `t2,${makerOrder.sourceChain},${makerOrder.id},${result.taker.id}: Order made`
                  );
                } catch (error) {
                  this.logger.error(
                    `Chain ${chainSymbol}: Failed to post multisig transaction of maker ${makerAddress} on chain ${makerOrder.targetChain} because of error: ${error.message}`
                  );
                }
              })();
            })
          );
        })
      );

      if (chainSymbol === this.baseChainSymbol) {
        if (targetHeight % this.options.orderBookSnapshotFinality === 0) {
          if (this.lastSnapshot) {
            let snapshotBaseChainHeight = this.lastSnapshot.chainHeights[this.baseChainSymbol];
            // Only refund if dexDisabledFromHeight is within the snapshot height range.
            if (
              chainOptions.dexDisabledFromHeight != null &&
              snapshotBaseChainHeight >= chainOptions.dexDisabledFromHeight &&
              snapshotBaseChainHeight - this.options.orderBookSnapshotFinality < chainOptions.dexDisabledFromHeight
            ) {
              try {
                await this.refundOrderBook(
                  this.lastSnapshot,
                  latestBlockTimestamp,
                  targetHeight,
                  chainOptions.dexMovedToAddress
                );
              } catch (error) {
                this.logger.error(`Failed to refund the order book according to config because of error: ${error.message}`);
              }
            }
            try {
              await this.saveSnapshot(this.lastSnapshot);
            } catch (error) {
              this.logger.error(`Failed to save snapshot because of error: ${error.message}`);
            }
          }
          this.lastSnapshot = {
            orderBook: this.tradeEngine.getSnapshot(),
            chainHeights: {...latestChainHeights}
          };
        }
      }
    }

    (async () => {
      // If the dividendProcessingStream is killed, the inner for-await-of loop will break;
      // in that case, it will continue with the iteration from the end of the stream.
      while (true) {
        for await (let event of dividendProcessingStream) {
          let {chainSymbol, chainHeight, toHeight, latestBlockTimestamp} = event;
          let chainOptions = this.options.chains[chainSymbol];
          let fromHeight = toHeight - chainOptions.dividendHeightInterval;
          let {readMaxBlocks} = chainOptions;
          if (fromHeight < 1) {
            fromHeight = 1;
          }

          let contributionData = {};
          let chainStorage = this._storageComponents[chainSymbol];
          let latestBlock = await this._getBlockAtHeight(chainStorage, fromHeight);

          while (true) {
            if (!latestBlock) {
              break;
            }
            let timestampedBlockList = await this._getLatestBlocks(chainStorage, latestBlock.timestamp, readMaxBlocks);
            let blocksToProcess = timestampedBlockList.filter((block) => block.height <= toHeight);
            for (let block of blocksToProcess) {
              let outboundTxns = await this._getOutboundTransactions(chainStorage, block.id, chainOptions.walletAddress);
              outboundTxns.forEach((txn) => {
                let contributionList = this._calculateContributions(chainSymbol, txn, chainOptions.exchangeFeeRate, chainOptions.exchangeFeeBase);
                contributionList.forEach((contribution) => {
                  if (!contributionData[contribution.walletAddress]) {
                    contributionData[contribution.walletAddress] = 0;
                  }
                  contributionData[contribution.walletAddress] += contribution.amount;
                });
              });
            }
            latestBlock = blocksToProcess[blocksToProcess.length - 1];
          }
          let {memberCount} = this.multisigWalletInfo[chainSymbol];
          let dividendList = this.dividendFunction(chainSymbol, contributionData, this.options.chains[chainSymbol], memberCount);
          for (let dividend of dividendList) {
            let txnAmount = dividend.amount - chainOptions.exchangeFeeBase;
            let dividendTxn = {
              amount: txnAmount.toString(),
              recipientId: dividend.walletAddress,
              height: chainHeight,
              timestamp: latestBlockTimestamp
            };
            try {
              await this.execMultisigTransaction(
                chainSymbol,
                dividendTxn,
                `d1,${fromHeight + 1},${toHeight}: Member dividend`
              );
            } catch (error) {
              this.logger.error(
                `Chain ${chainSymbol}: Failed to post multisig dividend transaction to member address ${dividend.walletAddress} because of error: ${error.message}`
              );
            }
          }
        }
      }
    })();

    let latestBlockReceivedTimestamp = null;
    let isInForkRecovery = false;

    let processBlockchains = async () => {
      if (lastProcessedTimestamp == null) {
        return;
      }
      if (isInForkRecovery) {
        if (this.isForked) {
          return;
        }
        isInForkRecovery = false;
        this.pendingTransfers.clear();
        lastProcessedTimestamp = await this.revertToLastSnapshot();
      }
      let orderedChainSymbols = [
        this.baseChainSymbol,
        this.quoteChainSymbol
      ];
      let [baseChainBlocks, quoteChainBlocks] = await Promise.all(
        orderedChainSymbols.map(async (chainSymbol) => {
          let storage = this._storageComponents[chainSymbol];
          let chainOptions = this.options.chains[chainSymbol];
          let timestampedBlockList = await this._getLatestBlocks(storage, lastProcessedTimestamp - 1, chainOptions.readMaxBlocks);
          return timestampedBlockList.map((block) => ({
            ...block,
            chainSymbol
          }));
        })
      );

      let baseChainFirstBlock = baseChainBlocks.shift();
      let quoteChainFirstBlock = quoteChainBlocks.shift();

      let baseChainLastBlock = baseChainBlocks[baseChainBlocks.length - 1];
      let quoteChainLastBlock = quoteChainBlocks[quoteChainBlocks.length - 1];

      if (!baseChainLastBlock || !quoteChainLastBlock) {
        return;
      }

      let orderedBlockList = [];

      if (baseChainLastBlock.timestamp <= quoteChainLastBlock.timestamp) {
        let safeQuoteChainBlocks = quoteChainBlocks.filter((block) => block.timestamp <= baseChainLastBlock.timestamp);
        let lastSafeBlock = safeQuoteChainBlocks[safeQuoteChainBlocks.length - 1];
        if (lastSafeBlock) {
          lastSafeBlock.isLastBlock = true;
        }
        baseChainLastBlock.isLastBlock = true;
        orderedBlockList = baseChainBlocks.concat(safeQuoteChainBlocks);
      } else {
        let safeBaseChainBlocks = baseChainBlocks.filter((block) => block.timestamp <= quoteChainLastBlock.timestamp);
        let lastSafeBlock = safeBaseChainBlocks[safeBaseChainBlocks.length - 1];
        if (lastSafeBlock) {
          lastSafeBlock.isLastBlock = true;
        }
        quoteChainLastBlock.isLastBlock = true;
        orderedBlockList = quoteChainBlocks.concat(safeBaseChainBlocks);
      }

      orderedBlockList.sort((a, b) => {
        let timestampA = a.timestamp;
        let timestampB = b.timestamp;
        if (timestampA < timestampB) {
          return -1;
        }
        if (timestampA > timestampB) {
          return 1;
        }
        if (a.chainSymbol === this.baseChainSymbol) {
          return -1;
        }
        return 1;
      });

      let latestChainHeights = {
        [this.baseChainSymbol]: baseChainFirstBlock.height,
        [this.quoteChainSymbol]: quoteChainFirstBlock.height
      };

      for (let block of orderedBlockList) {
        if (isInForkRecovery) {
          break;
        }
        latestChainHeights[block.chainSymbol] = block.height;
        try {
          await processBlock({
            chainSymbol: block.chainSymbol,
            chainHeight: block.height,
            latestChainHeights: {...latestChainHeights},
            isLastBlock: block.isLastBlock,
            blockData: {...block}
          });
          lastProcessedTimestamp = block.timestamp;
        } catch (error) {
          this.logger.error(
            `Encountered the following error while processing block id ${block.id} on chain ${block.chainSymbol} at height ${block.height}: ${error.stack}`
          );
          break;
        }
      }
    };

    let isProcessingBlocks = false;
    this._readBlocksInterval = setInterval(async () => {
      if (isProcessingBlocks) {
        return;
      }
      isProcessingBlocks = true;
      await processBlockchains();
      isProcessingBlocks = false;
    }, this.options.readBlocksInterval);

    let progressingChains = {};

    this.chainSymbols.forEach((chainSymbol) => {
      progressingChains[chainSymbol] = true;
    });

    let areAllChainsProgressing = () => {
      return Object.keys(progressingChains).every((chainSymbol) => progressingChains[chainSymbol]);
    }

    this.chainSymbols.forEach(async (chainSymbol) => {
      let chainOptions = this.options.chains[chainSymbol];
      let chainModuleAlias = chainOptions.moduleAlias;

      let lastSeenChainHeight = 0;
      let lastSeenBlockId;

      // This is to detect forks in the underlying blockchains.
      channel.subscribe(`${chainModuleAlias}:blocks:change`, async (event) => {
        let chainHeight = parseInt(event.data.height);
        latestBlockReceivedTimestamp = parseInt(event.data.timestamp);

        let isChainProgressing;
        if (chainHeight > lastSeenChainHeight) {
          isChainProgressing = true;
        } else if (chainHeight === lastSeenChainHeight && event.data.id === lastSeenBlockId) {
          isChainProgressing = true;
        } else {
          isChainProgressing = false;
        }
        progressingChains[chainSymbol] = isChainProgressing;
        lastSeenChainHeight = chainHeight;
        lastSeenBlockId = event.data.id;

        // If starting without a snapshot, use the timestamp of the first new block.
        if (lastProcessedTimestamp == null) {
          lastProcessedTimestamp = latestBlockReceivedTimestamp;
        }
        if (areAllChainsProgressing()) {
          this.isForked = false;
        } else {
          this.isForked = true;
          isInForkRecovery = true;
        }
      });
    });
    channel.publish(`${MODULE_ALIAS}:bootstrap`);
  }

  _calculateContributions(chainSymbol, transaction, exchangeFeeRate) {
    transaction = {...transaction};
    if (!transaction.asset) {
      transaction.asset = {};
    }
    if (!transaction.transferData) {
      return [];
    }
    let txnData = transaction.transferData.toString('utf8');
    // Only trade transactions (e.g. t1 and t2) are counted.
    if (txnData.charAt(0) !== 't') {
      return [];
    }
    transaction.asset.data = txnData;

    let memberSignatures = transaction.signatures ? transaction.signatures.split(',') : [];
    let amountBeforeFee = Math.floor(transaction.amount / (1 - exchangeFeeRate));

    return memberSignatures.map((signature) => {
      let walletAddress = this._getMemberWalletAddress(chainSymbol, transaction, signature);
      if (!walletAddress) {
        return null;
      }
      return {
        walletAddress,
        amount: amountBeforeFee
      };
    }).filter((dividend) => !!dividend);
  }

  _getMemberWalletAddress(chainSymbol, transaction, signature) {
    let memberPublicKey = Object.keys(this.multisigWalletInfo[chainSymbol].members).find((publicKey) => {
      return this._verifySignature(chainSymbol, publicKey, transaction, signature);
    });
    if (!memberPublicKey) {
      return null;
    }
    return getAddressFromPublicKey(memberPublicKey);
  }

  _isLimitOrderTooSmallToConvert(chainSymbol, amount, price) {
    if (chainSymbol === this.baseChainSymbol) {
      let quoteChainValue = Math.floor(amount / price);
      let quoteChainOptions = this.options.chains[this.quoteChainSymbol];
      return quoteChainValue <= quoteChainOptions.exchangeFeeBase;
    }
    let baseChainValue = Math.floor(amount * price);
    let baseChainOptions = this.options.chains[this.baseChainSymbol];
    return baseChainValue <= baseChainOptions.exchangeFeeBase;
  }

  _isMarketOrderTooSmallToConvert(chainSymbol, amount) {
    if (chainSymbol === this.baseChainSymbol) {
      let {price: quoteChainPrice} = this.tradeEngine.peekAsks() || {};
      let quoteChainValue = Math.floor(amount / quoteChainPrice);
      let quoteChainOptions = this.options.chains[this.quoteChainSymbol];
      return quoteChainValue <= quoteChainOptions.exchangeFeeBase;
    }
    let {price: baseChainPrice} = this.tradeEngine.peekBids() || {};
    let baseChainValue = Math.floor(amount * baseChainPrice);
    let baseChainOptions = this.options.chains[this.baseChainSymbol];
    return baseChainValue <= baseChainOptions.exchangeFeeBase;
  }

  async _getInboundTransactions(storage, blockId, walletAddress) {
    // TODO: When it becomes possible, use internal module API (using channel.invoke) to get this data instead of direct DB access.
    let txns = await storage.adapter.db.query(
      'select trs.id, trs.type, trs."senderId", trs."senderPublicKey", trs."timestamp", trs."recipientId", trs."amount", trs."transferData", trs.signatures from trs where trs."blockId" = $1 and trs."recipientId" = $2',
      [blockId, walletAddress]
    );
    return txns.map((txn) => ({
      ...txn,
      senderPublicKey: txn.senderPublicKey.toString('hex')
    }));
  }

  async _getOutboundTransactions(storage, blockId, walletAddress) {
    // TODO: When it becomes possible, use internal module API (using channel.invoke) to get this data instead of direct DB access.
    let txns = await storage.adapter.db.query(
      'select trs.id, trs.type, trs."senderId", trs."senderPublicKey", trs."timestamp", trs."recipientId", trs."amount", trs."transferData", trs.signatures from trs where trs."blockId" = $1 and trs."senderId" = $2',
      [blockId, walletAddress]
    );
    return txns.map((txn) => ({
      ...txn,
      senderPublicKey: txn.senderPublicKey.toString('hex')
    }));
  }

  async _getLatestBlocks(storage, fromTimestamp, limit) {
    // TODO: When it becomes possible, use internal module API (using channel.invoke) to get this data instead of direct DB access.
    return storage.adapter.db.query(
      'select blocks.id, blocks.height, blocks."numberOfTransactions", blocks.timestamp from blocks where timestamp > $1 limit $2',
      [fromTimestamp, limit]
    );
  }

  async _getBlockAtHeight(storage, targetHeight) {
    // TODO: When it becomes possible, use internal module API (using channel.invoke) to get this data instead of direct DB access.
    return (
      await storage.adapter.db.query(
        'select blocks.id, blocks."numberOfTransactions", blocks.timestamp from blocks where height = $1',
        [targetHeight]
      )
    )[0];
  }

  async _getBaseChainBlockTimestamp(height) {
    let baseChainStorage = this._storageComponents[this.baseChainSymbol];
    let firstBaseChainBlock = await this._getBlockAtHeight(baseChainStorage, height);
    return firstBaseChainBlock.timestamp;
  };

  async refundOrderBook(snapshot, timestamp, refundHeight, movedToAddress) {
    let allOrders = snapshot.bidLimitOrders.concat(snapshot.askLimitOrders);
    if (movedToAddress) {
      await Promise.all(
        allOrders.map(async (order) => {
          await this.refundOrder(
            order,
            timestamp,
            refundHeight,
            `r5,${order.id},${movedToAddress}: DEX has moved`
          );
        })
      );
    } else {
      await Promise.all(
        allOrders.map(async (order) => {
          await this.refundOrder(
            order,
            timestamp,
            refundHeight,
            `r6,${order.id}: DEX has been disabled`
          );
        })
      );
    }
    this.tradeEngine.clear();
  }

  async refundOrder(order, timestamp, refundHeight, reason) {
    let refundTxn = {
      sourceChain: order.sourceChain,
      sourceWalletAddress: order.sourceWalletAddress,
      height: refundHeight
    };
    if (order.sourceChain === this.baseChainSymbol) {
      refundTxn.sourceChainAmount = order.valueRemaining;
    } else {
      refundTxn.sourceChainAmount = order.sizeRemaining;
    }
    await this.execRefundTransaction(refundTxn, timestamp, reason);
  }

  async execRefundTransaction(txn, timestamp, reason) {
    let refundChainOptions = this.options.chains[txn.sourceChain];
    let flooredAmount = Math.floor(txn.sourceChainAmount);
    let refundAmount = BigInt(flooredAmount) - BigInt(refundChainOptions.exchangeFeeBase);
    // Refunds do not charge the exchangeFeeRate.

    if (refundAmount <= 0n) {
      throw new Error(
        'Failed to make refund because amount was less than or equal to 0'
      );
    }

    let refundTxn = {
      amount: refundAmount.toString(),
      recipientId: txn.sourceWalletAddress,
      height: txn.height,
      timestamp
    };
    await this.execMultisigTransaction(
      txn.sourceChain,
      refundTxn,
      reason
    );
  }

  // Broadcast the signature to all DEX nodes with a matching baseAddress and quoteAddress
  async _broadcastSignatureToSubnet(transactionId, signature, publicKey) {
    let actionRouteString = `${MODULE_ALIAS}?baseAddress=${this.baseAddress}&quoteAddress=${this.quoteAddress}`;
    this.channel.invoke('network:emit', {
      event: `${actionRouteString}:signature`,
      data: {
        signature,
        transactionId,
        publicKey
      }
    });
  }

  async execMultisigTransaction(targetChain, transactionData, message) {
    let chainOptions = this.options.chains[targetChain];
    let chainModuleAlias = chainOptions.moduleAlias;
    let txn = {
      type: 0,
      amount: transactionData.amount.toString(),
      recipientId: transactionData.recipientId,
      fee: liskTransactions.constants.TRANSFER_FEE.toString(),
      asset: {},
      timestamp: transactionData.timestamp,
      senderPublicKey: liskCryptography.getAddressAndPublicKeyFromPassphrase(chainOptions.sharedPassphrase).publicKey
    };
    if (message != null) {
      txn.asset.data = message;
    }
    let preparedTxn = liskTransactions.utils.prepareTransaction(txn, chainOptions.sharedPassphrase);
    let {signature, signSignature, ...transactionToHash} = preparedTxn;
    let txnHash = liskCryptography.hash(liskTransactions.utils.getTransactionBytes(transactionToHash));
    let multisigTxnSignature = liskCryptography.signData(txnHash, chainOptions.passphrase);
    let publicKey = liskCryptography.getAddressAndPublicKeyFromPassphrase(chainOptions.passphrase).publicKey;
    let walletAddress = getAddressFromPublicKey(publicKey);

    preparedTxn.signatures = [multisigTxnSignature];
    let processedSignatureSet = new Set();
    processedSignatureSet.add(multisigTxnSignature);

    let contributors = new Set();
    contributors.add(walletAddress);

    // If the pendingTransfers map already has a transaction with the specified id, delete the existing entry so
    // that when it is re-inserted, it will be added at the end of the queue.
    // To perform expiry using an iterator, it's essential that the insertion order is maintained.
    if (this.pendingTransfers.has(preparedTxn.id)) {
      this.pendingTransfers.delete(preparedTxn.id);
    }
    this.pendingTransfers.set(preparedTxn.id, {
      transaction: preparedTxn,
      targetChain,
      processedSignatureSet,
      contributors,
      publicKey,
      height: transactionData.height,
      timestamp: Date.now()
    });

    (async () => {
      // Add delay before broadcasting to give time for other nodes to independently add the transaction to their pendingTransfers lists.
      let sigBroadcastDelay = this.options.signatureBroadcastDelay == null ?
        DEFAULT_SIGNATURE_BROADCAST_DELAY : this.options.signatureBroadcastDelay;
      await wait(sigBroadcastDelay);
      try {
        await this._broadcastSignatureToSubnet(preparedTxn.id, multisigTxnSignature, publicKey);
      } catch (error) {
        this.logger.error(
          `Failed to broadcast signature to DEX peers for multisig transaction ${preparedTxn.id}`
        );
      }
    })();
  }

  async loadSnapshot() {
    let serializedSnapshot = await readFile(this.options.orderBookSnapshotFilePath, {encoding: 'utf8'});
    let snapshot = JSON.parse(serializedSnapshot);
    snapshot.orderBook.askLimitOrders.forEach((order) => {
      if (order.orderId != null) {
        order.id = order.orderId;
        delete order.orderId;
      }
    });
    snapshot.orderBook.bidLimitOrders.forEach((order) => {
      if (order.orderId != null) {
        order.id = order.orderId;
        delete order.orderId;
      }
      if (order.value == null) {
        order.value = order.size * order.price;
        order.valueRemaining = order.sizeRemaining * order.price;
        delete order.size;
        delete order.sizeRemaining;
      }
    });
    this.lastSnapshot = snapshot;
    this.tradeEngine.setSnapshot(snapshot.orderBook);
    let baseChainHeight = snapshot.chainHeights[this.baseChainSymbol];
    return this._getBaseChainBlockTimestamp(baseChainHeight);
  }

  async revertToLastSnapshot() {
    if (!this.lastSnapshot) {
      this.tradeEngine.clear();
      return;
    }
    this.tradeEngine.setSnapshot(this.lastSnapshot.orderBook);
    let baseChainHeight = this.lastSnapshot.chainHeights[this.baseChainSymbol];
    return this._getBaseChainBlockTimestamp(baseChainHeight);
  }

  async saveSnapshot(snapshot) {
    let baseChainHeight = snapshot.chainHeights[this.baseChainSymbol] || 0;
    let serializedSnapshot = JSON.stringify(snapshot);
    await writeFile(this.options.orderBookSnapshotFilePath, serializedSnapshot);

    try {
      await writeFile(
        path.join(
          this.options.orderBookSnapshotBackupDirPath,
          `snapshot-${baseChainHeight}.json`
        ),
        serializedSnapshot
      );
      let allSnapshots = await readdir(this.options.orderBookSnapshotBackupDirPath);
      let heightRegex = /[0-9]+/g;
      allSnapshots.sort((a, b) => {
        let snapshotHeightA = parseInt(a.match(heightRegex)[0] || 0);
        let snapshotHeightB = parseInt(b.match(heightRegex)[0] || 0);
        if (snapshotHeightA > snapshotHeightB) {
          return -1;
        }
        if (snapshotHeightA < snapshotHeightB) {
          return 1;
        }
        return 0;
      });
      let snapshotsToDelete = allSnapshots.slice(this.options.orderBookSnapshotBackupMaxCount || 200, allSnapshots.length);
      await Promise.all(
        snapshotsToDelete.map(async (fileName) => {
          await unlink(
            path.join(this.options.orderBookSnapshotBackupDirPath, fileName)
          );
        })
      );
    } catch (error) {
      this.logger.error(
        `Failed to backup snapshot in directory ${
          this.options.orderBookSnapshotBackupDirPath
        } because of error: ${
          error.message
        }`
      );
    }
  }

  async unload() {
    clearInterval(this._multisigExpiryInterval);
    clearInterval(this._readBlocksInterval);
    delete this._readBlocksInterval;
  }
};

function wait(duration) {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}
