// The design studio's platform assets, as a shop admin reads them (CP5 unit
// FN1; the Worker: cloudflare/src/routes/pod-studio-assets.ts, the shapes in
// docs/cf-port/CP5_WH_REPORT.md "Seller").
//
//   GET /v1/admin/pod/mockup-templates   { provisional, templates }   active templates only
//   GET /v1/admin/pod/3d-models          { models }                   active models only (unit FN2 reads it)
//
// Every request carries X-Shop-Id (adminRequest). These answers carry no
// money at all. The printers, the mappings and the design quote are FM's
// calls (./pod.js), reused as they are.

import { adminRequest } from './client.js';

export const MOCKUP_TEMPLATES_PATH = '/v1/admin/pod/mockup-templates';
export const MODELS_3D_PATH = '/v1/admin/pod/3d-models';

/** The active mockup templates: the answer's body as it is ({ provisional, templates }). */
export async function listMockupTemplates({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', MOCKUP_TEMPLATES_PATH, { shopId, signal });
  return {
    provisional: data?.provisional === true,
    templates: Array.isArray(data?.templates) ? data.templates : [],
  };
}

/** The active 3D models (unit FN2 adapts them). */
export async function list3dModels({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', MODELS_3D_PATH, { shopId, signal });
  return Array.isArray(data?.models) ? data.models : [];
}
