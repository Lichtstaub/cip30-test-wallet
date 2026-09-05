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
    return keys.length > 0;
  }

  // Default: one scan shortly after load, like many real dApps.
  // ?retry=1: rescan every 200 ms for up to 3 s, like a careful dApp.
  var retry = new URLSearchParams(location.search).get('retry') === '1';
  setTimeout(function () {
    if (scan() || !retry) return;
    var started = Date.now();
    var timer = setInterval(function () {
      if (scan() || Date.now() - started > 3000) clearInterval(timer);
    }, 200);
  }, 100);

  document.getElementById('connect').addEventListener('click', function () {
    var out = document.getElementById('connect-result');
    var cardano = window.cardano;
    var key = cardano && walletKeys(cardano)[0];
    if (!key) {
      out.textContent = 'no wallet';
      return;
    }
    cardano[key].enable().then(function (api) {
      return api.getNetworkId();
    }).then(function (id) {
      out.textContent = 'network ' + id;
    }).catch(function (e) {
      out.textContent = 'error ' + (e && e.code);
    });
  });
})();
