const express = require('express');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const R = require('ramda');
const path = require('path');
const swaggerDocument = require('./swagger.json');
const Block = require('../blockchain/block');
const Transaction = require('../blockchain/transaction');
const TransactionAssertionError = require('../blockchain/transactionAssertionError');
const BlockAssertionError = require('../blockchain/blockAssertionError');
const HTTPError = require('./httpError');
const ArgumentError = require('../util/argumentError');
const CryptoUtil = require('../util/cryptoUtil');
const timeago = require('timeago.js');
const config = require('../config');
var multiline = require('multiline');
var nodemailer = require('nodemailer');
var validator = require('validator');
var lowerCase = require('lower-case');
const mongoose    = require('mongoose');
const promise = mongoose.connect(config.connectionString, {
    useMongoClient: true,

});
promise.then(function(db) {

    db.on("error", console.error.bind(console, "connection error"));
    db.once("open", function(callback) {
        console.log("Connection succeeded.");
    });
});
const User   = require('../app/models/user');

class HttpServer {
    constructor(node, blockchain, operator, miner) {
        this.app = express();

        const projectWallet = (wallet) => {
            return {
                id: wallet.id,
                addresses: R.map((keyPair) => {
                    return keyPair.publicKey;
                }, wallet.keyPairs)
            };
        };

        this.app.use(bodyParser.json());

        this.app.set('view engine', 'pug');
        this.app.set('views', path.join(__dirname, 'views'));
        this.app.locals.formatters = {
            time: (rawTime) => {
                const timeInMS = new Date(rawTime * 1000);
                return `${timeInMS.toLocaleString()} - ${timeago().format(timeInMS)}`;
            },
            hash: (hashString) => {
                return hashString != '0' ? `${hashString.substr(0, 5)}...${hashString.substr(hashString.length - 5, 5)}` : '<empty>';
            },
            amount: (amount) => amount.toLocaleString()
        };
        this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

        this.app.get('/blockchain', (req, res) => {
            if (req.headers['accept'] && req.headers['accept'].includes('text/html'))
                res.render('blockchain/index.pug', {
                    pageTitle: 'Blockchain',
                    blocks: blockchain.getAllBlocks()
                });
            else
                throw new HTTPError(400, 'Accept content not supported');
        });

        this.app.get('/blockchain/blocks', (req, res) => {
            res.status(200).send(blockchain.getAllBlocks());
        });

        this.app.get('/blockchain/blocks/latest', (req, res) => {
            let lastBlock = blockchain.getLastBlock();
            if (lastBlock == null) throw new HTTPError(404, 'Last block not found');

            res.status(200).send(lastBlock);
        });

        this.app.put('/blockchain/blocks/latest', (req, res) => {
            let requestBlock = Block.fromJson(req.body);
            let result = node.checkReceivedBlock(requestBlock);

            if (result == null) res.status(200).send('Requesting the blockchain to check.');
            else if (result) res.status(200).send(requestBlock);
            else throw new HTTPError(409, 'Blockchain is update.');
        });

        this.app.get('/blockchain/blocks/:hash([a-zA-Z0-9]{64})', (req, res) => {
            let blockFound = blockchain.getBlockByHash(req.params.hash);
            if (blockFound == null) throw new HTTPError(404, `Block not found with hash '${req.params.hash}'`);

            res.status(200).send(blockFound);
        });

        this.app.get('/blockchain/blocks/:index', (req, res) => {
            let blockFound = blockchain.getBlockByIndex(parseInt(req.params.index));
            if (blockFound == null) throw new HTTPError(404, `Block not found with index '${req.params.index}'`);

            res.status(200).send(blockFound);
        });

        this.app.get('/blockchain/blocks/transactions/:transactionId([a-zA-Z0-9]{64})', (req, res) => {
            let transactionFromBlock = blockchain.getTransactionFromBlocks(req.params.transactionId);
            if (transactionFromBlock == null) throw new HTTPError(404, `Transaction '${req.params.transactionId}' not found in any block`);

            res.status(200).send(transactionFromBlock);
        });

        this.app.get('/blockchain/transactions', (req, res) => {
            if (req.headers['accept'] && req.headers['accept'].includes('text/html'))
                res.render('blockchain/transactions/index.pug', {
                    pageTitle: 'Unconfirmed Transactions',
                    transactions: blockchain.getAllTransactions()
                });
            else
                res.status(200).send(blockchain.getAllTransactions());
        });

        this.app.get('/blockchain/transactionbyid/:transactionId([a-zA-Z0-9]{64})',(req,res) => {
           let transactionById = blockchain.getTransactionById(req.params.transactionId);
            if (transactionById == null) throw new HTTPError(404, `Invalid Transaction '${req.params.transactionId}' found`);

            res.status(200).send(transactionById);
        });

        this.app.post('/blockchain/transactions', (req, res) => {
            let requestTransaction = Transaction.fromJson(req.body);
            let transactionFound = blockchain.getTransactionById(requestTransaction.id);

            if (transactionFound != null) throw new HTTPError(409, `Transaction '${requestTransaction.id}' already exists`);

            try {
                let newTransaction = blockchain.addTransaction(requestTransaction);
                res.status(201).send(newTransaction);
            } catch (ex) {
                if (ex instanceof TransactionAssertionError) throw new HTTPError(400, ex.message, requestTransaction, ex);
                else throw ex;
            }
        });

        this.app.get('/blockchain/transactions/unspent', (req, res) => {
            res.status(200).send(blockchain.getUnspentTransactionsForAddress(req.query.address));
        });

        this.app.get('/operator/wallets', (req, res) => {
            let wallets = operator.getWallets();

            let projectedWallets = R.map(projectWallet, wallets);

            res.status(200).send(projectedWallets);
        });

        this.app.post('/operator/wallets', (req, res) => {
            let password = req.body.password;
            let mailid = req.body.mailid;
            let hash = mailid +','+ password;
            console.log('hash value...',hash);
            if(password == null || mailid == null) throw new HTTPError(500, 'Please pass the required data');
            User.findOne({username:mailid},function (err,result) {
                if(err) throw new HTTPError(400, 'Password must contain more than 4 words');
                //if (R.match(/\w+/g, password).length <= 4) throw new HTTPError(400, 'Password must contain more than 4 words');
                if(result){
                    res.status(201).send('{"response":0,"message":"User already registered"}');
                }
                else{

                    if (password.length <= 4) throw new HTTPError(400, 'Password must contain more than 4 characters');
                    let newWallet = operator.createWalletFromPassword(hash);

                    let projectedWallet = projectWallet(newWallet);
                    console.log('wallet id..',projectedWallet.id);

                    let hash = mailid+','+password;
                    let passwordHash = CryptoUtil.hash(hash);

                    try {
                        if (!operator.checkWalletPassword(walletId, passwordHash)) throw new HTTPError(403, `Invalid password or mail for wallet '${walletId}'`);

                        let newAddress = operator.generateAddressForWallet(walletId);

                    } catch (ex) {
                        if (ex instanceof ArgumentError) throw new HTTPError(400, ex.message, walletId, ex);
                        else throw ex;
                    }
                    var myobj = new User({
                        username: mailid,
                        password: password,
                        walletId: projectedWallet.id
                    });
                    myobj.save(function (err) {
                        if(err) throw new HTTPError(500, err);

                        res.status(201).send({ address: newAddress });

                    });

                }

            });

        });

        this.app.post('/carecoin/logout',(req,res) => {
            console.log('request body to logout...',req.body);

            if(userParam.from === 'ios'){
                console.log('logged out from ios mobile..');
                notify.updateMany({
                        'username':req.body.mailid,
                        'devices.ios.deviceid':req.body.deviceid,
                        'devices.ios.deviceToken':req.body.deviceToken
                    },
                    {
                        '$set' :
                            {

                                'devices.ios.$.login':false
                            }
                    },function (err,doc) {
                        if(err){
                            console.log(err);
                            res(err);
                        }else {
                            console.log(doc);
                            res({response:'3',message:'You have been successfully logged out'});
                        }

                    });

            }else{
                console.log('logged out from android mobile....');
                notify.updateMany({
                        'username':username1,
                        'devices.android.deviceid':userParam.deviceid,
                        'devices.android.deviceToken':userParam.deviceToken
                    },
                    {
                        '$set' :
                            {

                                'devices.android.$.login':false
                            }
                    },function (err,doc) {
                        if(err){
                            console.log(err);
                            res(err);
                        }else {
                            console.log(doc);
                            res({response:'3',message:'You have been successfully logged out'});
                        }

                    });

            }
        });

        this.app.post('/carecoin/changepassword',(req,res) => {
           let mailid = req.body.mailid;
           let currentpassword = req.body.currentpassword;
           let newpassword = req.body.newpassword;
           console.log('mailid..',mailid);
           if(mailid == null || currentpassword == null || newpassword == null) throw new HTTPError(500,'please pass the valid data')
           if(currentpassword == newpassword) res.status(201).send({"response":"2","message":"Your cuurent password and new password both are same"});
            User.findOne({username:mailid},function(err,result){
               if(err) throw new HTTPError(400,err);
               if(result){
                   if(result.password == currentpassword){
                       console.log('password has changed successfully...');
                       var myobj = { username: mailid };
                       var newvalues = {username: mailid, password:newpassword};
                       User.update(
                           myobj,newvalues,
                           function (err, doc) {
                               if (err) {
                                   throw new HTTPError(err);
                               }
                               else {

                                   res.status(201).send({"response":"3","message":"successfully changed your password"});
                               }
                           });

                   }else{
                       res.status(201).send({"response":"0","message":"current password is wrong"});

                   }
               }else{
                   res.status(201).send({"response":"1","message":"Provide valid user information"});

               }
           })
        });

        this.app.post('/carecoin/forgot', (req, res) => {

            let mailid = req.body.mailid;

            console.log('mailid...',mailid);
            if(mailid == null) throw new HTTPError(500, 'Please pass the required data');
            User.findOne({username:mailid},function (err,result) {
                if(err) throw new HTTPError(400, 'Please pass correct registered mail');
                //if (R.match(/\w+/g, password).length <= 4) throw new HTTPError(400, 'Password must contain more than 4 words');
                if(result){
                    var str = multiline(function(){/*
				    	<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Basic Bootstrap Template</title>
<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css" integrity="sha384-BVYiiSIFeK1dGmJRAkycuHAHRg32OmUcww7on3RYdg4Va+PmSTsz/K68vbdEjh4u" crossorigin="anonymous">
<!-- Optional Bootstrap theme -->
<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap-theme.min.css" integrity="sha384-rHyoN1iRsVXV4nD0JutlnGaslCJuC7uwjduW9SVrLvRYooPp2bWYgmgJQIXwl/Sp" crossorigin="anonymous">


	<style>


  .background
  {
  position: absolute;
  width: 700px;
  height: 800px;
  z-index: 15;
  top: 10%;
  left: 25%;
  bottom: 30%;
  margin: -100px 0 0 -150px;
  padding-left: 5%;
  padding-top: 10%;
  padding-bottom: 0 none;
  background-image: url(http://54.234.239.245/image/background.png);

  }
  .img{
    width:100%;
    max-width:600px;
}


.box {

  border-radius: 25px;
  position: absolute;
  width: 600px;
  height: 600px;
  z-index: 15;
  top: 30%;
  left: 30%;
  bottom: 30%;
  margin: -100px 0 0 -150px;
  background: #fff;
}




.button {

    border-radius: 20px;
    background-color: #6888F5;
   height: 15px;
   width: 90px;
    color: white;
    padding: 15px 32px;
    text-align: center;
    text-decoration: none;
    display: inline-block;
    font-size: 16px;
    margin: 4px 2px;
    cursor: pointer;
}

.inner
{
    border: 1px solid #000000;

    border-radius: 25px;
  width: 580px;
  height: 580px;
  margin: 0 auto;
  margin-top: 15px;

}
.image{
  margin-right: 15px;
  float: right;
}
        .image2{
            margin-left: 20px;
            float:left;
            margin-top: -60px;
        }
.textplace
{
  margin-left: 25px;
  margin-top:150px;
}
.textno{

  margin-left: 25px;
  margin-top:50px;
}
.center
 {
  margin-top:100px;
   background-color:  #6888F5;
    padding: 1px;
}
.copyryt
{
  margin-top: 5px;
  margin-left: 240px;
    width: 60%;

}
.copyryttt
{
  margin-top: 5px;
  margin-left: 230px;
    width: 60%;

}
.clipimg{
  margin-left: 40px;
  margin-top: 40px;

}
.copyryted
{

  margin-left: 230px;


}


</style>

</head>
<body>

    <script src="https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js"></script>
    <script src="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/js/bootstrap.min.js" integrity="sha384-Tc5IQib027qvyjSMfHjOMaLkfuWVxZxUPnCJA7l2mCWNIpG9mGCD8wGNIcPD7Txa" crossorigin="anonymous"></script>

    <body background=="http://54.234.239.245/image/background.png">


  <div class="background">
	<div class="box">

		<div class="inner">

      <div class="image">

      <img src="http://54.234.239.245/image/logo.png" >
      </div>

      <div class="textplace">
        <h3>
          Dear %m
        </h3>
        <P>
               We received a Request that you forgot your Password of Your Spectrum account.Use this One Time Password (OTP) toreset your password.


        </P>
        <div class="button">%s</div>
        </div>
        <div class="textno">If You Didn't mean to Reset your Password ,then you can just ignore this Your Password will not change</div>

        <div class="center"></div>
        <div class="copyryt">
         Copyright  &copy; 2017
        </div>
        <div class="copyryttt">www.Spectrum.com</div>

    <div class="copyryted">
<font color="blue">All Rights Reserved</font>
  </div>




 <div>
            </div>

        </div>
      </div>
    </div>


</body>
</html>


						 */ });
                    var html = str.replace("%s", result.password);
                    var html1 = html.replace("%m",mailid);


                    var transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: {
                            user: 'contact.spectrum.in@gmail.com',
                            pass: 'vedas2017'
                        }
                    });
                    var mailOptions = {
                        from: 'contact.spectrum.in@gmail.com',
                        to: mailid,
                        subject: 'Forgot password',
                        html: html1
                    };

                    transporter.sendMail(mailOptions, function(error, info){
                        if (error) {
                            console.log(error);
                        } else {
                            console.log('Email sent: ' + info.response);
                        }
                    });
                    res.status(201).send('{"response":"3","message":"Your password has sent to your mail."}');

                }
                else {
                    res.status(201).send('{"response":"0","message":"This mailid not yet registered"}');

                }

            });

        });

        this.app.get('/operator/wallets/:walletId', (req, res) => {
            let walletFound = operator.getWalletById(req.params.walletId);
            if (walletFound == null) throw new HTTPError(404, `Wallet not found with id '${req.params.walletId}'`);

            let projectedWallet = projectWallet(walletFound);

            res.status(200).send(projectedWallet);
        });

        this.app.post('/operator/wallets/:walletId/transactions', (req, res) => {
            let walletId = req.params.walletId;
            let password = req.headers.password;
            let mailid = req.headers.mailid;
            let hash = mailid +','+ password;
            if (mailid == null || password == null) throw new HTTPError(401, 'Wallet\'s password is missing.');
            let passwordHash = CryptoUtil.hash(hash);

            try {
                if (!operator.checkWalletPassword(walletId, passwordHash)) throw new HTTPError(403, `Invalid password for wallet '${walletId}'`);

                let newTransaction = operator.createTransaction(walletId, req.body.fromAddress, req.body.toAddress, req.body.amount, req.body['changeAddress'] || req.body.fromAddress);

                newTransaction.check();

                let transactionCreated = blockchain.addTransaction(Transaction.fromJson(newTransaction));
                res.status(201).send(transactionCreated);
            } catch (ex) {
                if (ex instanceof ArgumentError || ex instanceof TransactionAssertionError) throw new HTTPError(400, ex.message, walletId, ex);
                else throw ex;
            }
        });

        this.app.get('/operator/wallets/:walletId/addresses', (req, res) => {
            let walletId = req.params.walletId;
            try {
                let addresses = operator.getAddressesForWallet(walletId);
                res.status(200).send(addresses);
            } catch (ex) {
                if (ex instanceof ArgumentError) throw new HTTPError(400, ex.message, walletId, ex);
                else throw ex;
            }
        });

        this.app.post('/operator/wallets/:walletId/addresses', (req, res) => {
            let walletId = req.params.walletId;
            let password = req.headers.password;
            let mailid = req.headers.mailid;

            if (password == null || mailid == null) throw new HTTPError(401, 'Wallet\'s password or mailid is missing.');
            let hash = mailid+','+password;
            let passwordHash = CryptoUtil.hash(hash);

            try {
                if (!operator.checkWalletPassword(walletId, passwordHash)) throw new HTTPError(403, `Invalid password or mail for wallet '${walletId}'`);

                let newAddress = operator.generateAddressForWallet(walletId);
                res.status(201).send({ address: newAddress });
            } catch (ex) {
                if (ex instanceof ArgumentError) throw new HTTPError(400, ex.message, walletId, ex);
                else throw ex;
            }
        });

        this.app.get('/operator/:addressId/balance', (req, res) => {
            let addressId = req.params.addressId;

            try {
                let balance = operator.getBalanceForAddress(addressId);
                res.status(200).send({ balance: balance });
            } catch (ex) {
                if (ex instanceof ArgumentError) throw new HTTPError(404, ex.message, { addressId }, ex);
                else throw ex;
            }
        });

        this.app.get('/node/peers', (req, res) => {
            res.status(200).send(node.peers);
        });

        this.app.post('/node/peers', (req, res) => {
            let newPeer = node.connectToPeer(req.body);
            res.status(201).send(newPeer);
        });

        this.app.get('/node/transactions/:transactionId([a-zA-Z0-9]{64})/confirmations', (req, res) => {
            node.getConfirmations(req.params.transactionId)
                .then((confirmations) => {
                    res.status(200).send({ confirmations: confirmations });
                });
        });

        this.app.post('/miner/mine', (req, res, next) => {

            let walletId = req.body.walletId;
            let password = req.body.password;
            let mailid = req.body.mailid;

            console.log('wallet id....',walletId);
            if (password == null || mailid == null) throw new HTTPError(401, 'Wallet\'s password or mailid is missing.');
            let hash = mailid+','+password;
            let passwordHash = CryptoUtil.hash(hash);

            try {
                if (!operator.checkWalletPassword(walletId, passwordHash)) throw new HTTPError(403, `Invalid password or mail for wallet '${walletId}'`);
                miner.mine(req.body.rewardAddress, req.body['feeAddress'] || req.body.rewardAddress)
                    .then((newBlock) => {
                        newBlock = Block.fromJson(newBlock);
                        blockchain.addBlock(newBlock);
                        res.status(201).send(newBlock);
                    })
                    .catch((ex) => {
                        if (ex instanceof BlockAssertionError && ex.message.includes('Invalid index')) next(new HTTPError(409, 'A new block were added before we were able to mine one'), null, ex);
                        else next(ex);
                    });

            } catch (ex) {
                if (ex instanceof ArgumentError) throw new HTTPError(400, ex.message, walletId, ex);
                else throw ex;
            }

        });

        this.app.use(function (err, req, res, next) {  // eslint-disable-line no-unused-vars
            if (err instanceof HTTPError) res.status(err.status);
            else res.status(500);
            res.send(err.message + (err.cause ? ' - ' + err.cause.message : ''));
        });
    }

    listen(host, port) {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(port, host, (err) => {
                if (err) reject(err);
                console.info(`Listening http on port: ${this.server.address().port}, to access the API documentation go to http://${host}:${this.server.address().port}/api-docs/`);
                resolve(this);
            });
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            this.server.close((err) => {
                if (err) reject(err);
                console.info('Closing http');
                resolve(this);
            });
        });
    }
}

module.exports = function(app,io) {HttpServer};