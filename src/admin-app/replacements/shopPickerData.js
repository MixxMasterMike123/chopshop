// src/components/admin/shopPickerData.js for the admin build (alias list,
// vite.admin.config.js). The picker lists the shops `GET /v1/me` names: a
// tenant admin's memberships (a suspended or closed shop is listed with
// status 'disabled', which the picker marks "Pausad"; choosing it changes
// nothing, the provider honours only a usable shop), a platform user's open
// acting-as grants. A platform user opens a grant in the platform console.

import { getMe } from '../../api/admin/session.js';
import { pickerShopsOf } from '../../api/admin/actingAs.js';

export async function loadPickerShops() {
  return pickerShopsOf(await getMe());
}
