// Copyright (c) 2018-2019, TurtlePay Developers
//
// Please see the included LICENSE file for more information.

'use strict'

const AES = require('./lib/aes.js')
const BodyParser = require('body-parser')
const Compression = require('compression')
const Config = require('./config.json')
const DatabaseBackend = require('./lib/databaseBackend.js')
const Express = require('express')
const Helmet = require('helmet')
const RabbitMQ = require('amqplib')
const TurtleCoinUtils = require('turtlecoin-utils').CryptoNote
const util = require('util')
const UUID = require('uuid/v4')

const cryptoUtils = new TurtleCoinUtils()
const walletQueue = 'request.wallet'

const publicRabbitHost = process.env.RABBIT_PUBLIC_SERVER || 'localhost'
const publicRabbitUsername = process.env.RABBIT_PUBLIC_USERNAME || ''
const publicRabbitPassword = process.env.RABBIT_PUBLIC_PASSWORD || ''
const buttonContainerPassword = process.env.BUTTON_CONTAINER_PASSWORD || ''

const crypto = new AES({ password: buttonContainerPassword })

/* Helps us to build the RabbitMQ connection string */
function buildConnectionString (host, username, password) {
  var result = ['amqp://']

  if (username.length !== 0 && password.length !== 0) {
    result.push(username + ':')
    result.push(password + '@')
  }

  result.push(host)

  return result.join('')
}

/* This is a special magic function to make sure that when
   we parse a number that the whole thing is actually a
   number */
function toNumber (term) {
  if (typeof term === 'number' && term % 1 === 0) {
    return term
  }
  if (parseInt(term).toString() === term) {
    return parseInt(term)
  } else {
    return false
  }
}

/* We neet to set up our RabbitMQ environment */
var rabbit
var channel
var replyQueue
(async function () {
  rabbit = await RabbitMQ.connect(buildConnectionString(publicRabbitHost, publicRabbitUsername, publicRabbitPassword))
  channel = await rabbit.createChannel()
  replyQueue = await channel.assertQueue('', { exclusive: true, durable: false })
}())

/* Let's set up a standard logger. Sure it looks cheap but it's
   reliable and won't crash */
function log (message) {
  console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
}

function logHTTPRequest (req, params) {
  params = params || ''
  log(util.format('[REQUEST] (%s) %s %s', req.ip, req.path, params))
}

function logHTTPError (req, message) {
  message = message || 'Parsing error'
  log(util.format('[ERROR] (%s) %s: %s', req.ip, req.path, message))
}

/* Set up our database connection */
const database = new DatabaseBackend({
  host: Config.mysql.host,
  port: Config.mysql.port,
  username: Config.mysql.username,
  password: Config.mysql.password,
  database: Config.mysql.database,
  connectionLimit: Config.mysql.connectionLimit
})

log('Connected to database backend at ' + database.host + ':' + database.port)

const app = Express()

/* Automatically decode JSON input from client requests */
app.use(BodyParser.json())

/* Catch body-parser errors */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) {
    return res.status(400).send()
  }
  next()
})

/* Set up a few of our headers to make this API more functional */
app.use((req, res, next) => {
  res.header('X-Requested-With', '*')
  res.header('Access-Control-Allow-Origin', Config.corsHeader)
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.header('Cache-Control', 'max-age=30, public')
  next()
})

/* Set up our system to use Helmet */
app.use(Helmet())

/* Last but certainly not least, enable compression because we're going to need it */
app.use(Compression())

function validateNewRequest (req) {
  const atomicAmount = toNumber(req.body.amount)
  const callback = req.body.callback || false
  const address = req.body.address || false
  const name = req.body.name || false
  const callerData = req.body.userDefined || {}
  const confirmations = toNumber(req.body.confirmations)

  /* Validate that the caller has specified an amount for the request */
  if (!atomicAmount || atomicAmount === 0 || atomicAmount < 0) {
    return { error: {
      message: 'Invalid Amount Supplied',
      retCode: 400
    } }
  }

  const amount = (atomicAmount / Math.pow(10, Config.coinDecimals))

  /* Validate that the caller has supplied a valid CryptoNote address
     for us to send funds to */
  try {
    cryptoUtils.decodeAddress(address)
  } catch (e) {
    return { error: {
      message: 'Invalid address supplied',
      retCode: 400
    } }
  }

  /* Verify that the caller supplied us with an acceptable callback
     URL that we'll post back to later */
  if (callback) {
    if (callback.substring(0, 4).toLowerCase() !== 'http') {
      return { error: {
        message: 'Invalid callback URL supplied',
        retCode: 400
      } }
    }
  }

  /* If the caller has supplied the number of confirmations that they
     are willing to wait and override our defaults, then we're going
     to validate that it's okay. */
  var requestConfirmations
  if (confirmations !== false) {
    /* If the caller requested 0 or less or more confirmations than we
       allow, we're going to reject their request */
    if (confirmations < 0 || confirmations > Config.maximumConfirmations) {
      return { error: {
        message: 'Invalid confirmations requested',
        retCode: 400
      } }
    }
    requestConfirmations = confirmations
  } else {
    /* If the caller did not supply the number of confirmations required
       then we'll use the default value */
    requestConfirmations = Config.defaultConfirmations
  }

  return {
    atomicAmount,
    amount,
    callback,
    address,
    name,
    callerData,
    requestConfirmations
  }
}

function processNewRequest (validationResult) {
  return new Promise((resolve, reject) => {
    var cancelTimer

    try {
    /* Generate a random request ID for use by the RPC client */
      const requestId = UUID().toString().replace(/-/g, '')

      /* Assemble the data we're passing to the backend workers */
      const walletRequest = {
        amount: validationResult.atomicAmount,
        address: validationResult.address,
        confirmations: validationResult.requestConfirmations,
        callback: validationResult.callback,
        callerData: validationResult.callerData
      }

      /* Here, we set up our worker side of the queue to grab the replyQueue
       from the backend workers so we can spit the results back to the client */
      channel.consume(replyQueue.queue, (message) => {
      /* If we received a valid message and it matches our request let's tell the caller */
        if (message !== null && message.properties.correlationId === requestId) {
          var workerResponse = JSON.parse(message.content.toString())
          var sendToAddress = workerResponse.address

          /* Acknowledge to RabbitMQ that we've received the request and we're handling it */
          channel.ack(message)

          /* We received a response so we don't need this timer anymore */
          if (cancelTimer !== null) {
            clearTimeout(cancelTimer)
          }

          return resolve({
            logMessage: JSON.stringify(walletRequest),
            response: {
              sendToAddress: sendToAddress,
              atomicAmount: validationResult.atomicAmount,
              amount: validationResult.amount,
              userDefined: validationResult.callerData,
              startHeight: workerResponse.scanHeight,
              endHeight: workerResponse.maxHeight,
              confirmations: validationResult.requestConfirmations,
              callbackPublicKey: workerResponse.publicKey,
              qrCode: 'https://chart.googleapis.com/chart?cht=qr&chs=256x256&chl=' + Config.coinUri + '://' + sendToAddress + '?amount=' + validationResult.atomicAmount + ((validationResult.name) ? '&name=' + encodeURIComponent(validationResult.name) : '')
            }
          })
        } else if (message !== null) {
        /* There was a message, but it wasn't for us. Let it go back
           in the queue for someone else to handle */
          channel.nack(message)
        }
      })

      /* Send the request to create a wallet to the queue for processing
       by the backend workers and give it a time limit of 2s */
      channel.sendToQueue(walletQueue, Buffer.from(JSON.stringify(walletRequest)), {
        correlationId: requestId,
        replyTo: replyQueue.queue,
        expiration: 2000
      })

      /* Define a timer that if we don't get a response back in 5s or less
       that we need to consider the request failed and let the caller know
       that something went wrong */
      cancelTimer = setTimeout(() => {
        return resolve({
          error: {
            message: 'RPC request time out',
            retCode: 500
          }
        })
      }, 5000)
    } catch (e) {
      return resolve({
        error: {
          message: e.toString(),
          retCode: 500
        }
      })
    }
  })
}

/* This is the meat and potatoes entry method for the public API
   aka, submitting a new request for funds to the processing engine */
app.post('/v1/new', (req, res) => {
  /* Validate that our request has no errors in the data that the
     caller supplied, or let them know we won't be proceeding */
  const validationResult = validateNewRequest(req)
  if (validationResult.error) {
    logHTTPError(req, validationResult.error.message)
    return res.status(validationResult.error.retCode).send()
  }

  /* Try to process the request using the backend workers */
  processNewRequest(validationResult).then((result) => {
    if (result.error) {
      logHTTPError(req, result.error.message)
      return res.status(result.error.retCode).send()
    }

    logHTTPRequest(req, result.logMessage)
    return res.json(result.response)
  })
})

app.post('/v1/button', (req, res) => {
  const encryptedButtonPayload = req.body.buttonPayload || false
  const callerData = req.body.userDefined || {}

  if (!encryptedButtonPayload) {
    logHTTPError(req, 'No button payload provided')
    return res.status(400).send()
  }

  try {
    /* Try to decrypt the data from the button payload */
    const validationResult = crypto.decrypt(encryptedButtonPayload)

    /* Add to the request if additional userDefined data provided */
    Object.assign(validationResult.userDefined, callerData)

    /* Try to process the request using the backend workers */
    processNewRequest(validationResult).then((result) => {
      if (result.error) {
        logHTTPError(req, result.error.message)
        return res.status(result.error.retCode).send()
      }

      logHTTPRequest(req, result.logMessage)
      return res.json(result.response)
    })
  } catch (e) {
    logHTTPError(req, 'Invalid button payload provided')
    return res.status(400).send()
  }
})

app.post('/v1/button/new', (req, res) => {
  /* Validate that our request has no errors in the data that the
     caller supplied, or let them know we won't be proceeding */
  const validationResult = validateNewRequest(req)
  if (validationResult.error) {
    logHTTPError(req, validationResult.error.message)
    return res.status(validationResult.error.retCode).send()
  }

  const encryptedButtonPayload = crypto.encrypt(validationResult)

  logHTTPRequest(req, JSON.stringify(validationResult))

  return res.json({
    buttonPayload: encryptedButtonPayload
  })
})

/* Response to options requests for preflights */
app.options('*', (req, res) => {
  return res.status(200).send()
})

/* This is our catch all to return a 404-error */
app.all('*', (req, res) => {
  logHTTPError(req, 'Requested URL not Found (404)')
  return res.status(404).send()
})

app.listen(Config.httpPort, Config.bindIp, () => {
  log('HTTP server started on ' + Config.bindIp + ':' + Config.httpPort)
})
