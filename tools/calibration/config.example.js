// Copy to config.js (which git ignores) and fill in. The key is the PUBLIC key of the tenant.
// Leave the endpoint empty when the ingestion server serves this page itself (config "calibrationDir"), which is the
// simplest setup. Set it only if the page is hosted somewhere else.
window.CALIBRATION = {
  endpoint: '',
  publicKey: 'pk_...',
  // Shown in the consent text. Fill in both before inviting anyone.
  retention: '90 dias depois do fim do teste',
  contact: 'nome e e-mail do organizador',
}
