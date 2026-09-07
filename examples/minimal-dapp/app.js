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

  document.getElementById('commit').addEventListener('click', function () {
    var out = document.getElementById('commit-result');
    if (!connectedApi) {
      out.textContent = 'not connected';
      return;
    }
    out.textContent = 'signing';
    connectedApi.signTx(DEMO_TX.unsignedHex, false).then(function (witnessSetHex) {
      // Replace the empty witness set (a0) with the wallet's witness set.
      var signed = DEMO_TX.unsignedHex.slice(0, DEMO_TX.bodyEndHex) + witnessSetHex + DEMO_TX.unsignedHex.slice(DEMO_TX.bodyEndHex + 2);
      return connectedApi.submitTx(signed);
    }).then(function (hash) {
      out.textContent = 'submitted ' + hash;
    }).catch(function (e) {
      out.textContent = e && e.code === 2 ? 'declined' : 'error ' + (e && e.code);
    });
  });
})();
