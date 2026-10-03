// Page-native observations. Everything here runs under the page's real CSP,
// which makes it the ground truth the injected probes are compared against.
(function () {
  var evalResult = document.getElementById('eval-result');
  try {
    // eslint-disable-next-line no-new-func
    new Function('return 1')();
    evalResult.textContent = 'ok';
  } catch (e) {
    evalResult.textContent = 'blocked';
  }

  var walletsEl = document.getElementById('wallets');
  var countEl = document.getElementById('scan-count');
  var scans = 0;

  function walletKeys(cardano) {
    return Object.getOwnPropertyNames(cardano).filter(function (k) {
      return cardano[k] && typeof cardano[k].enable === 'function';
    });
  }

  function scan() {
    scans += 1;
    countEl.textContent = String(scans);
    var cardano = window.cardano;
    if (!cardano) {
      walletsEl.textContent = 'none';
      return false;
    }
    var keys = walletKeys(cardano);
    walletsEl.textContent = keys.length ? keys.join(',') : 'none';
    document.getElementById('wallet-found').hidden = keys.length === 0;
    return keys.length > 0;
  }

  // Default: one scan shortly after load, like many real dApps.
  // ?delay=<ms>: delay that first scan, like a page that waits on something else first.
  // ?retry=1: rescan every 200 ms for up to 3 s, like a careful dApp.
  var retry = new URLSearchParams(location.search).get('retry') === '1';
  var delay = Number(new URLSearchParams(location.search).get('delay')) || 100;
  setTimeout(function () {
    if (scan() || !retry) return;
    var started = Date.now();
    var timer = setInterval(function () {
      if (scan() || Date.now() - started > 3000) clearInterval(timer);
    }, 200);
  }, delay);

  var EXPECTED_NETWORK = 0;
  var connectedApi = null;

  function networkName(id) {
    return id === 1 ? 'mainnet' : 'preprod';
  }

  document.getElementById('connect').addEventListener('click', function () {
    connectedApi = null;
    var out = document.getElementById('connect-result');
    var cardano = window.cardano;
    var key = cardano && walletKeys(cardano)[0];
    if (!key) {
      out.textContent = 'no wallet';
      return;
    }
    cardano[key].enable().then(function (api) {
      return api.getNetworkId().then(function (id) {
        if (id !== EXPECTED_NETWORK) {
          // The human message the design asks for, instead of a cryptic SDK error later.
          out.textContent = 'wrong network: wallet is on ' + networkName(id) + ', this demo expects ' + networkName(EXPECTED_NETWORK);
          return;
        }
        connectedApi = api;
        out.textContent = 'network ' + id;
      });
    }).catch(function (e) {
      out.textContent = 'error ' + (e && e.code);
    });
  });

  // Signs and submits one of the fixed demo transactions, splicing the wallet's
  // witness set in place of the empty one (a0).
  function signAndSubmit(demoTx, resultId) {
    var out = document.getElementById(resultId);
    if (!connectedApi) {
      out.textContent = 'not connected';
      return;
    }
    out.textContent = 'signing';
    var phase = 'signTx';
    connectedApi.signTx(demoTx.unsignedHex, false).then(function (witnessSetHex) {
      var signed = demoTx.unsignedHex.slice(0, demoTx.bodyEndHex) + witnessSetHex + demoTx.unsignedHex.slice(demoTx.bodyEndHex + 2);
      phase = 'submitTx';
      return connectedApi.submitTx(signed);
    }).then(function (hash) {
      out.textContent = 'submitted ' + hash;
    }).catch(function (e) {
      // CIP-30 codes depend on the call: code 2 is TxSignError UserDeclined for signTx,
      // but TxSendError Failure for submitTx, where the node refused the transaction.
      var code = e && e.code;
      if (phase === 'signTx' && code === 2) out.textContent = 'declined';
      else if (phase === 'submitTx' && code === 2) out.textContent = 'send failed: ' + e.info;
      else out.textContent = 'error ' + code;
    });
  }

  document.getElementById('commit').addEventListener('click', function () {
    signAndSubmit(DEMO_TX, 'commit-result');
  });
  document.getElementById('vote').addEventListener('click', function () {
    signAndSubmit(DEMO_VOTE_TX, 'vote-result');
  });
  document.getElementById('delegate').addEventListener('click', function () {
    signAndSubmit(DEMO_DELEG_TX, 'delegate-result');
  });

  function firstWallet() {
    var keys = walletKeys(window.cardano || {});
    return keys.length ? window.cardano[keys[0]] : null;
  }

  function hexOf(text) {
    return Array.prototype.map.call(new TextEncoder().encode(text), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  // Signs a message with the reward address, the way forum logins do.
  document.getElementById('sign-message').addEventListener('click', function () {
    var out = document.getElementById('sign-message-result');
    var wallet = firstWallet();
    if (!wallet) return (out.textContent = 'no wallet');
    wallet.enable().then(function (api) {
      return api.getRewardAddresses().then(function (addrs) {
        return api.signData(addrs[0], hexOf('demo message'));
      });
    }).then(function (sig) {
      out.textContent = 'signed ' + sig.signature.length;
    }, function (e) {
      out.textContent = 'error ' + (e && e.code);
    });
  });

  // Tries the bare DRep ID first and the type 6 address second, stopping on a real decline.
  document.getElementById('drep-login').addEventListener('click', function () {
    var out = document.getElementById('drep-login-result');
    var wallet = firstWallet();
    if (!wallet) return (out.textContent = 'no wallet');
    wallet.enable({ extensions: [{ cip: 95 }] }).then(function (api) {
      if (!api.cip95) throw { code: 'no-cip95' };
      return api.cip95.getPubDRepKey().then(function (pub) {
        // window.__demoDrepCandidates is only defined by the test hook, run by hand this
        // button has nothing to try, so fail cleanly instead of calling undefined.
        if (typeof window.__demoDrepCandidates !== 'function') throw { code: 'no-candidates' };
        return window.__demoDrepCandidates(pub);
      }).then(function (candidates) {
        var i = 0;
        function next() {
          return api.cip95.signData(candidates[i], hexOf('drep login')).catch(function (e) {
            i += 1;
            if ((e && e.code === 3) || i >= candidates.length) throw e;
            return next();
          });
        }
        return next();
      });
    }).then(function () {
      out.textContent = 'signed';
    }, function (e) {
      out.textContent = 'error ' + (e && e.code);
    });
  });

  // Reads the CBOR header at offset i of a byte array: major type, argument, next offset.
  // Enough for value = coin / [coin, multiasset], no library needed.
  // Numbers instead of BigInt, fine for the demo amounts (below 2^53).
  function cborHead(bytes, i) {
    var first = bytes[i];
    var major = first >> 5;
    var info = first & 31;
    if (info < 24) return { major: major, arg: info, next: i + 1 };
    var size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    var arg = 0;
    for (var k = 1; k <= size; k++) arg = arg * 256 + bytes[i + k];
    return { major: major, arg: arg, next: i + 1 + size };
  }

  function bytesOf(hex) {
    var out = [];
    for (var i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  document.getElementById('balance').addEventListener('click', function () {
    var out = document.getElementById('balance-result');
    if (!connectedApi) {
      out.textContent = 'not connected';
      return;
    }
    connectedApi.getBalance().then(function (hex) {
      var bytes = bytesOf(hex);
      var head = cborHead(bytes, 0);
      var coin;
      var kinds = 0;
      if (head.major === 0) coin = head.arg;
      else {
        var coinHead = cborHead(bytes, head.next);
        coin = coinHead.arg;
        var policies = cborHead(bytes, coinHead.next);
        var p = policies.next;
        for (var j = 0; j < policies.arg; j++) {
          var policy = cborHead(bytes, p);
          var names = cborHead(bytes, policy.next + policy.arg);
          kinds += names.arg;
          p = names.next;
          for (var n = 0; n < names.arg; n++) {
            var name = cborHead(bytes, p);
            var quantity = cborHead(bytes, name.next + name.arg);
            p = quantity.next;
          }
        }
      }
      out.textContent = coin + ' lovelace, ' + kinds + (kinds === 1 ? ' token kind' : ' token kinds');
    }).catch(function (e) {
      out.textContent = 'error ' + (e && e.code);
    });
  });
})();
