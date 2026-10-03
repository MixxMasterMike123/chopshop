// The content pages' data modules (unit FG) against the dev API, under Node:
//   node --test src/admin-app/dev/content-dev.test.mjs
// A fetch stub hands every request of the admin client to the dev API's
// router, so the replacements run as the browser runs them.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { setRequestShopId } from '../../api/admin/client.js';
import { createState, route } from './dev-api.mjs';
import * as collections from '../replacements/adminCollectionsData.js';
import * as collectionEdit from '../replacements/adminCollectionEditData.js';
import * as menu from '../replacements/adminMenuData.js';
import * as pagesList from '../replacements/adminPagesData.js';
import * as pageEdit from '../replacements/adminPageEditData.js';
import * as storefront from '../replacements/adminStorefrontData.js';
import { forgetProducts } from '../replacements/contentSources.js';

const realFetch = globalThis.fetch;
let state;
let cookie;
let log;

function install() {
  state = createState();
  const answer = route(state, 'POST', new URL('/_api/api/auth/sign-in/email', 'http://dev.invalid'), {}, { email: 'admin@example.com', password: 'dev-password-1' });
  cookie = answer.setCookie.split(';')[0];
  log = [];
  forgetProducts();
  globalThis.fetch = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}), cookie };
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body) body = { raw: Buffer.from(await new Response(init.body).arrayBuffer()) };
    log.push([init.method ?? 'GET', String(url)]);
    const out = route(state, init.method ?? 'GET', new URL(String(url), 'http://dev.invalid'), headers, body);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  };
}

before(() => setRequestShopId('test-shop-a'));
after(() => {
  globalThis.fetch = realFetch;
  setRequestShopId(null);
});
beforeEach(install);

const rejectsWith = async (promise, message) => {
  await assert.rejects(promise, (error) => {
    assert.match(error.userMessage ?? error.message, message);
    return true;
  });
};

describe('collections', () => {
  it('the list reads as documents; the star, the order and delete write', async () => {
    const rows = await collections.loadShopCollections('test-shop-a');
    assert.deepEqual(rows.map((c) => c.handle), ['hem-och-linne', 'tryck', 'nyheter']);
    assert.equal(rows[0].productCount, 2);
    assert.match(rows[0].imageUrl, /^data:/);
    await collections.setCollectionFeatured(rows[1].id, true);
    // Move the third to the front: only collections whose place changed are written.
    log.length = 0;
    await collections.saveCollectionOrder([rows[2], rows[0], rows[1]]);
    assert.deepEqual(log.map(([m]) => m), ['PATCH', 'PATCH', 'PATCH']);
    const after = await collections.loadShopCollections('test-shop-a');
    assert.deepEqual(after.map((c) => c.handle), ['nyheter', 'hem-och-linne', 'tryck']);
    assert.equal(after[2].featured, true);
    await collections.deleteShopCollection(rows[2].id);
    assert.equal((await collections.loadShopCollections('test-shop-a')).length, 2);
  });

  it('the picker: products by name with their tags', async () => {
    const { products, availableTags } = await collectionEdit.loadPickerProducts('test-shop-a');
    assert.ok(products.some((p) => p.id === 'prod-towel'));
    assert.equal(products.some((p) => p.id === 'prod-old'), false);
    assert.deepEqual(availableTags, ['Linne', 'Nyhet', 'Tryck']);
  });

  it('a new manual collection: created, its members set, then published', async () => {
    const data = { title: 'Nytt', handle: 'nytt', description: '', imageUrl: '', type: 'manual', productIds: ['prod-tee', 'prod-cap'], rule: { tag: '' }, published: true, featured: false, sortOrder: null };
    log.length = 0;
    const id = await collectionEdit.saveCollection({ id: undefined, isNew: true, shopId: 'test-shop-a', data, form: data });
    assert.deepEqual(log.map(([m, u]) => `${m} ${u.replace('/_api/v1/admin/collections', '')}`), ['POST ', `PUT /${id}/products`, `PATCH /${id}`]);
    const form = await collectionEdit.loadCollection(id);
    assert.deepEqual([form.productIds, form.published, form.type], [['prod-tee', 'prod-cap'], true, 'manual']);
  });

  it('refusals are said: a taken handle, a removed member (nothing is left behind)', async () => {
    assert.equal(await collectionEdit.handleIsTaken('test-shop-a', 'tryck', undefined), true);
    assert.equal(await collectionEdit.handleIsTaken('test-shop-a', 'tryck', 'col-tryck'), false);
    const base = { title: 'Dubbel', handle: 'tryck', description: '', imageUrl: '', type: 'manual', productIds: [], rule: { tag: '' }, published: false, featured: false };
    await rejectsWith(collectionEdit.saveCollection({ isNew: true, shopId: 'test-shop-a', data: base, form: base }), /redan slug "tryck"/);
    const ghost = { ...base, handle: 'spok', productIds: ['prod-gone'] };
    await rejectsWith(collectionEdit.saveCollection({ isNew: true, shopId: 'test-shop-a', data: ghost, form: ghost }), /finns inte längre/);
    assert.equal((await collections.loadShopCollections('test-shop-a')).some((c) => c.handle === 'spok'), false);
  });

  it('editing: a smart one keeps its tag; members are written only when they changed', async () => {
    const form = await collectionEdit.loadCollection('col-hem');
    assert.equal(form.savedImageUrl.startsWith('data:'), true);
    const data = { title: 'Hem och linne', handle: 'hem-och-linne', description: 'x', imageUrl: form.imageUrl, type: 'manual', productIds: form.productIds, rule: { tag: '' }, published: true, featured: true, sortOrder: 0 };
    log.length = 0;
    await collectionEdit.saveCollection({ id: 'col-hem', isNew: false, shopId: 'test-shop-a', data, form });
    assert.deepEqual(log.map(([m]) => m), ['PATCH']);
    log.length = 0;
    await collectionEdit.saveCollection({ id: 'col-hem', isNew: false, shopId: 'test-shop-a', data: { ...data, productIds: ['prod-cap'] }, form });
    assert.deepEqual(log.map(([m]) => m), ['PATCH', 'PUT']);
    assert.deepEqual((await collectionEdit.loadCollection('col-hem')).productIds, ['prod-cap']);
    const smart = await collectionEdit.loadCollection('col-tryck');
    assert.equal(smart.rule.tag, 'Tryck');
  });

  it('the cover: uploaded as a product_media object, written by id, cleared by an empty address', async () => {
    const file = new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'cover.png', { type: 'image/png' });
    const url = await collectionEdit.uploadCollectionCover(file, 'test-shop-a');
    assert.match(url, /^data:image\/png/);
    const form = await collectionEdit.loadCollection('col-nytt');
    const data = { title: 'Nyheter i höst', handle: 'nyheter', description: '', imageUrl: url, type: 'manual', productIds: [], rule: { tag: '' }, published: false, featured: false };
    await collectionEdit.saveCollection({ id: 'col-nytt', isNew: false, shopId: 'test-shop-a', data, form });
    assert.equal((await collectionEdit.loadCollection('col-nytt')).imageUrl, url);
    const saved = await collectionEdit.loadCollection('col-nytt');
    await collectionEdit.saveCollection({ id: 'col-nytt', isNew: false, shopId: 'test-shop-a', data: { ...data, imageUrl: '' }, form: saved });
    assert.equal((await collectionEdit.loadCollection('col-nytt')).imageUrl, '');
  });
});

describe('pages', () => {
  it('the list: every page in full (translations, SEO line), newest change first; delete refreshes', async () => {
    const seen = [];
    const stop = pagesList.subscribeToPages('test-shop-a', (pages) => seen.push(pages), (error) => assert.fail(error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen.at(-1).map((p) => p.slug), ['om-oss', 'kontakt', 'frakt']);
    assert.deepEqual(Object.keys(seen.at(-1)[0].content).sort(), ['en-GB', 'sv-SE']);
    assert.equal(seen.at(-1)[0].updatedAt.toDate().getUTCFullYear(), 2026);
    await pagesList.deleteShopPage('page-frakt');
    assert.deepEqual(seen.at(-1).map((p) => p.slug), ['om-oss', 'kontakt']);
    stop();
  });

  it('a page is saved as per-language maps and read back', async () => {
    const formData = { title: { 'sv-SE': 'Villkor' }, slug: 'villkor-test', content: { 'sv-SE': '<p>Text</p>' }, status: 'draft', metaTitle: '', metaDescription: '' };
    const id = await pageEdit.savePage({ isNewPage: true, formData, newStatus: 'published', shopId: 'test-shop-a' });
    const page = await pageEdit.loadPage(id);
    assert.deepEqual([page.slug, page.status, page.title], ['villkor-test', 'published', { 'sv-SE': 'Villkor' }]);
    await pageEdit.savePage({ id, isNewPage: false, formData: { ...formData, content: { 'sv-SE': '<p>Ny text</p>' } }, newStatus: 'draft', shopId: 'test-shop-a' });
    assert.equal((await pageEdit.loadPage(id)).content['sv-SE'], '<p>Ny text</p>');
    assert.equal(await pageEdit.loadPage('nope'), null);
  });

  it('the Worker\'s refusals are said: a reserved slug, a taken slug, unsafe HTML with its reason', async () => {
    const formData = { title: { 'sv-SE': 'X' }, slug: 'kategori', content: { 'sv-SE': '<p>x</p>' }, metaTitle: '', metaDescription: '' };
    await rejectsWith(pageEdit.savePage({ isNewPage: true, formData, newStatus: 'draft', shopId: 'test-shop-a' }), /reserverad/);
    await rejectsWith(pageEdit.savePage({ isNewPage: true, formData: { ...formData, slug: 'om-oss' }, newStatus: 'draft', shopId: 'test-shop-a' }), /redan den sluggen/);
    await rejectsWith(pageEdit.savePage({ isNewPage: true, formData: { ...formData, slug: 'ny', content: { 'sv-SE': '<p onclick="x()">x</p>' } }, newStatus: 'draft', shopId: 'test-shop-a' }), /händelseattribut/);
    await rejectsWith(pageEdit.savePage({ isNewPage: true, formData: { ...formData, slug: 'Fel Slug' }, newStatus: 'draft', shopId: 'test-shop-a' }), /Sluggen får bara/);
  });

  it('attachments are not part of this build', () => {
    assert.equal(pageEdit.ATTACHMENTS_ENABLED, false);
  });
});

describe('the menu', () => {
  it('reads products, collections and pages; saves the whole array as the identity\'s menu', async () => {
    const loaded = await menu.loadMenuBuilder('test-shop-a');
    assert.deepEqual(loaded.categories, ['Accessoarer', 'Hem', 'Tröjor']);
    assert.deepEqual(loaded.tags, ['Linne', 'Nyhet', 'Tryck']);
    assert.deepEqual(loaded.collections.map((c) => c.handle), ['hem-och-linne', 'tryck']); // the draft is not offered
    assert.deepEqual(loaded.pages.map((p) => p.slug), ['kontakt', 'om-oss']);
    assert.deepEqual(loaded.menu, []);
    await menu.saveMenu([{ type: 'home', target: '', label: 'Hem' }, { type: 'collection', target: 'tryck', label: 'Tryck' }], 'test-shop-a');
    const again = await menu.loadMenuBuilder('test-shop-a');
    assert.deepEqual(again.menu.map((m) => m.label), ['Hem', 'Tryck']);
  });
});

describe('the storefront\'s look', () => {
  it('a logo is uploaded as a shop_branding object, saved by id, read back as an address, removed by clearing it', async () => {
    const before = await storefront.loadBranding('test-shop-a');
    assert.equal(before.accent, '#0E5E63');
    const file = new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])], 'logo.png', { type: 'image/png' });
    const url = await storefront.uploadBrandImage(file, 'logo', 'test-shop-a');
    await storefront.saveBranding({ accent: '#112233', templateId: 'nord', logoUrl: url, faviconUrl: '', heroImageUrl: '' }, 'test-shop-a');
    const stored = JSON.parse(JSON.stringify((await (await fetch('/_api/v1/admin/settings', { headers: { 'x-shop-id': 'test-shop-a' } })).json()).settings.storeIdentity));
    assert.match(stored.logoObjectId, /^obj-/);
    assert.equal('logoUrl' in stored, false);
    assert.equal(stored.accent, '#112233');
    assert.equal(stored.tagline, 'Invented goods for testing.'); // another page's key stays
    const reread = await storefront.loadBranding('test-shop-a');
    assert.equal(reread.logoUrl, url);
    await storefront.saveBranding({ logoUrl: '' }, 'test-shop-a');
    const cleared = (await (await fetch('/_api/v1/admin/settings', { headers: { 'x-shop-id': 'test-shop-a' } })).json()).settings.storeIdentity;
    assert.equal(cleared.logoObjectId, null);
  });

  it('the categories of the products; a file that is not an image is refused in words', async () => {
    assert.deepEqual(await storefront.loadShopCategories('test-shop-a'), ['Accessoarer', 'Hem', 'Tröjor']);
    const bad = new File([Buffer.from('hello')], 'x.png', { type: 'text/plain' });
    await assert.rejects(storefront.uploadBrandImage(bad, 'logo', 'test-shop-a'));
  });
});
