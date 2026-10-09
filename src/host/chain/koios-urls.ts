// The public Koios URL of each network. A module of its own that imports
// nothing, so validating the options does not load the chain clients.

export const KOIOS_URLS: Record<'mainnet' | 'preprod' | 'preview', string> = Object.freeze({
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
});
