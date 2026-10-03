// AdminPageEdit's data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminPageEditData.js (the older build's, Firebase). Same
// names, same meaning; the shapes are bridged by adapters/content.js.
//
//   open   GET /v1/admin/pages/:id
//   save   POST /v1/admin/pages (a new page) or PATCH (title, content, SEO
//          texts as per-language maps; the first publish dates the page)
//
// The Worker's refusals are said in the page's toast: a slug it reserves or
// has taken, content it will not hold (`content_refused`, with the reason).
// No attachments (D94): ATTACHMENTS_ENABLED is false and the tab is not drawn.
// A legal page is the seller's own text in the identity (D79), so its slugs
// are reserved here and no legal edit is stamped.

import { AdminApiError } from '../../api/admin/client.js';
import { createPage, getPage, updatePage } from '../../api/admin/content.js';
import { pageBody, pageDocFromApi, pageProblem, pageRefusal } from '../adapters/content.js';

export const ATTACHMENTS_ENABLED = false;

function sayable(message, cause, field = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.userMessage = message;
  error.field = field;
  return error;
}

export async function loadPage(id) {
  return pageDocFromApi(await getPage(id));
}

export async function savePage({ id, isNewPage, formData, newStatus, shopId }) {
  const problem = pageProblem(formData);
  if (problem) throw sayable(problem, null, 'slug');
  const body = pageBody(formData, newStatus);
  try {
    if (isNewPage) return (await createPage(body, { shopId })).pageId;
    await updatePage(id, body, { shopId });
    return id;
  } catch (error) {
    const refusal = error instanceof AdminApiError ? pageRefusal(error) : null;
    throw refusal ? sayable(refusal.message, error, refusal.field) : error;
  }
}
