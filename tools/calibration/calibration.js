/* Sends one labelled visit to the ingestion server.
   The endpoint and the public key come from config.js, never from the URL. */
;(function () {
  var config = window.CALIBRATION || {}
  var form = document.getElementById('form')
  var consent = document.getElementById('consent')
  var submit = document.getElementById('submit')
  var statusBox = document.getElementById('status')
  var idPattern = /^[A-Za-z0-9_.:-]{1,128}$/

  if (config.retention) document.getElementById('retention').textContent = config.retention
  if (config.contact) document.getElementById('contact').textContent = config.contact

  function show(kind, message) {
    statusBox.hidden = false
    statusBox.className = kind
    statusBox.textContent = message
  }

  if (!config.publicKey || typeof window.FingerprintJS === 'undefined') {
    submit.disabled = true
    consent.disabled = true
    show('error', 'Esta página não está configurada. Avise o organizador do teste.')
    return
  }

  consent.addEventListener('change', function () {
    submit.disabled = !consent.checked
  })

  function clean(value) {
    return value.trim().replace(/\s+/g, '-')
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    var participant = clean(document.getElementById('participant').value)
    var device = clean(document.getElementById('device').value)
    var linkedId = participant + '.' + device

    if (!consent.checked) {
      return show('error', 'Marque a caixa de concordância para participar.')
    }
    if (!participant || !device || !idPattern.test(linkedId)) {
      return show(
        'error',
        'Use só letras, números e os símbolos _ - . : nos dois campos, sem espaços, acentos nem @. ' +
          'Não escreva seu nome ou e-mail.',
      )
    }

    submit.disabled = true
    show('', 'Enviando…')
    // Empty means the same address as this page, which is the case when the ingestion server serves the page
    var base = (config.endpoint || '').replace(/\/$/, '')
    var key = encodeURIComponent(config.publicKey)

    fetch(base + '/v1/nonce?k=' + key, { credentials: 'include' })
      .then(function (response) {
        if (!response.ok) throw new Error('nonce ' + response.status)
        return response.json()
      })
      .then(function (data) {
        return window.FingerprintJS.collectAndSend(
          { endpoint: base + '/v1/collect?k=' + key, credentials: 'include' },
          { nonce: data.nonce, linkedId: linkedId },
        )
      })
      .then(function (result) {
        show(
          'ok',
          'Obrigado! Visita registrada. Código da visita: ' +
            result.requestId.slice(0, 8) +
            '. Volte nos dias combinados com o organizador.',
        )
        submit.disabled = !consent.checked
      })
      .catch(function (error) {
        show(
          'error',
          'Não foi possível enviar (' +
            (error && error.message ? error.message : 'erro') +
            '). Tente de novo; se repetir, avise o organizador.',
        )
        submit.disabled = !consent.checked
      })
  })
})()
