/** The ICA hosts the hub talks to. Injectable so tests point them at local fakes; nothing else may hard-code them. */
export type IcaEndpoints = { ims: string; web: string; gateway: string; handla: string; handlaStores: string };
export const DEFAULT_ICA_ENDPOINTS: IcaEndpoints = {
  ims: 'https://ims.icagruppen.se',
  web: 'https://www.ica.se',
  gateway: 'https://apimgw-pub.ica.se',
  handla: 'https://handlaprivatkund.ica.se',
  handlaStores: 'https://handla.ica.se',
};

/**
 * The ICA app's OAuth client, registered per install through dynamic client registration (DCR). The bootstrap
 * credentials below are not ours and not a per-user secret: they are the public client credential distributed in
 * ICA's Android/iOS app, also used by existing open-source ICA clients (taken from spike/lib/app-auth.ts). They only
 * allow calling `/register`, which hands out a fresh client; logging in still needs BankID.
 * `ICA_APP_DCR_CLIENT_SECRET` overrides the secret (config.ts) if ICA rotates it.
 */
export const ICA_APP_DCR_CLIENT_ID = 'ica-app-dcr-registration';
export const DEFAULT_ICA_APP_DCR_CLIENT_SECRET = 'uxLHTBvZ-Z2fV-SbrHl1E-tz7vB3jQFrwAdSLlbVMMu1rxDdvJU0s8KGu9d1wLS4';
export const ICA_APP_SOFTWARE_ID = 'dcr-ica-app-template';
/** The app's custom-scheme redirect. The hub never fetches it: it only reads the code from the Location header. */
export const ICA_APP_REDIRECT_URI = 'icacurity://app';
