/* jshint node: true */
'use strict';

var http = require('http');
var crypto = require('crypto');
var request = require('request');

global.isInIdentityExchange = false;

module.exports = function identityExchange (app, replicationManager) {

  // TODO: Add this to the Thali Replication Manager itself
  replicationManager.on('peerAvailabilityChanged', function (peers) {
    peers.forEach(function (peer) {
      if (peer.peerName.indexOf(';') !== -1) {
        var split = peer.peerName.split(';');
        peer.peerFriendlyName = split[1];
        peer.peerName = split[0];

        replicationManager.emit('peerIdentityExchange', peer);
      }
    });
  });

  var originalDeviceHash,
      newDeviceHash;

  function startIdentityExchange(myFriendlyName, cb) {
    if (global.isInIdentityExchange) {
      return cb(new Error('Already in identity exchange'));
    }
    global.isInIdentityExchange = true;
    replicationManager.once('stopped', function () {

      replicationManager.once('started', function () {
        cb(null, newDeviceHash);
      });

      // TODO: Get it from the replication manager instead of the field
      originalDeviceHash = replicationManager._deviceName;
      newDeviceHash = replicationManager._deviceName + ';' + myFriendlyName;

      replicationManager.once('startError', cb);
      replicationManager.start(
        replicationManager._port,
        replicationManager._dbName,
        replicationManager._deviceName + ';' + myFriendlyName);
    });

    replicationManager.once('stopError', cb);
    replicationManager.stop();
  }

  function stopIdentityExchange(cb) {
    global.isInIdentityExchange = false;

    // TODO: Clean up all pending exchanges

    replicationManager.once('stopped', function () {

      replicationManager.once('started', function () {
        cb(null, originalDeviceHash);
      });

      replicationManager.once('startError', cb);
      replicationManager.start(
        replicationManager._port,
        replicationManager._dbName,
        originalDeviceHash);
    });

    replicationManager.once('stopError', cb);
    replicationManager.stop();
  }

  var
    pkMineBuffer,
    pkOtherBuffer,
    rnMine,
    exchangeCb;

  function cleanupIdentityExchange(cb) {
    replicationManager._emitter.connect.disconnect(localPeerIdentifier, function (err) {
      // TODO: Log error
      cb();
    });
  }

  var localPeerIdentifier;

  function executeIdentityExchange(peerIdentifier, pkMine, pkOther, cb) {
    if (!global.isInIdentityExchange) {
      return cb(new Error('Identity Exchange not started'));
    }

    localPeerIdentifier = peerIdentifier;
    pkMineBuffer = new Buffer(pkMine);
    pkOtherBuffer = new Buffer(pkOther);

    rnMine = crypto.randomBytes(32);

    // TODO: Check if already connected

    replicationManager._emitter.connect(peerIdentifier, function (err, port) {
      if (err) { return cb(err); }

      var compared = pkMineBuffer.compare(pkOtherBuffer);

      if (compared < 0) {
        // My hash is smaller
        var concatHash = Buffer.concat([pkMineBuffer, pkOtherBuffer]);
        var cbHash = crypto.createHmac('sha256', rnMine);
        var cbBuffer = cbHash.update(concatHash);
        var cbValue = cbBuffer.toString('base64');

        var rnOtherReq = request.post({
          url: 'http://localhost:' + port + '/identity/cb',
          body: {
            cbValue: cbValue,
            pkMine: pkMine
          }
        });

        rnOtherReq.once('response', function (response) {
          // TODO: Check for 500 status for retry
          if (response.status !== 200) {
            return cleanupIdentityExchange(function () {
              cb(new Error('Invalid exchange'));
            });
          }

          var rnOther = new Buffer(response.body.rnOther);
          var pkO = new Buffer(response.body.pkOther);

          if (!pkO.equals(pkOtherBuffer)) {
            return cleanupIdentityExchange(function () {
              cb(new Error('Invalid exchange'));
            });
          }

          var rnMineReq = request.post({
            url: 'http://localhost:' + port + '/identity/rnmine',
            body: {
              rnMine: rnMine.toString('base64'),
              pkMine: pkMine
            }
          });

          rnMineReq.once('response', function (response) {
            // TODO: Check for 500
            if (response.status !== 200) {
              return cleanupIdentityExchange(function () {
                cb(new Error('Invalid exchange'));
              });
            }

            var newConcat = Buffer.concat([pkOtherBuffer, pkMineBuffer, rnMine]);
            var newCrypto = crypto.createHmac('sha256', rnOther);
            var newHash = newCrypto.update(newConcat);
            var newBuffer = newHash.digest();

            var value = parseInt(newBuffer.toString('hex'), 16) % Math.pow(10, 6);
            cleanupIdentityExchange(function () {
              cb(null, value);
            });

          });
        });
      } else if (compared > 0) {
        // My hash is bigger and rest is done in cb express endpoint
        exchangeCb = cb;
      } else {
        cb(new Error('Hashes cannot be equal'));
      }
    });
  }

  var cbValue;

  app.post('/identity/cb', function (req, res) {
    if (!global.isInIdentityExchange) {
      return res.status(400).end();
    }

    cbValue = new Buffer(req.body.cbValue);
    var buf = new Buffer(req.body.pkMine);
    if (!buf.equals(pkOtherBuffer)) {
      return res.status(400).end();
    }

    res.status(200).json({
      pkOther: pkMineBuffer.toString('base64'),
      rnOther: rnMine.toString('base64')
    });
  });

  app.post('/identity/rnmine', function (req, res) {
    var rnOther = new Buffer(req.body.rnMine);
    var newBuff = Buffer.concat([pkOtherBuffer, pkMineBuffer]);
    var hmac = crypto.createHmac('sha256', rnOther);
    hmac.update(newBuff);
    var ret = hmac.digest();

    // No match
    if (!ret.equals(cbValue)) {
      return res.status(400).end();
    }

    res.status(200).end();

    var finalBuff = Buffer.concat([pkMineBuffer, pkOtherBuffer, rnOther]);
    hmac = crypto.createHmac('sha256', rnMine);
    hmac.update(finalBuff);
    ret = hmac.digest();
    var value = parseInt(ret.toString('hex'), 16) % Math.pow(10, 6);
    cleanupIdentityExchange(function () {
      exchangeCb(null, value);
    });
  });

  return {
    startIdentityExchange: startIdentityExchange,
    executeIdentityExchange: executeIdentityExchange,
    stopIdentityExchange: stopIdentityExchange
  };
};
