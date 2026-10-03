// The content adapters under Node: node --test src/admin-app/adapters/content.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_CONTENT, brandingFromIdentity, brandingPatch, collectionBody, collectionFormFromApi, collectionRowFromApi,
  collectionLimitProblem, languageMap, membersChanged, pageBody, pageDocFromApi, pageProblem, pageRefusal, categoriesOf, tagsOf,
} from './content.js';

describe('collections', () => {
  it('a list row reads as the document: rule.tag, imageUrl, a member count', () => {
    const row = collectionRowFromApi({
      collectionId: 'c1', handle: 'h', title: 'T', type: 'smart', ruleTag: 'Tryck', published: true, featured: false,
      sortOrder: null, image: { url: 'https://img.example/x.png' }, productCount: 0,
    });
    assert.deepEqual([row.id, row.rule.tag, row.imageUrl, row.productCount, row.sortOrder], ['c1', 'Tryck', 'https://img.example/x.png', 0, undefined]);
  });

  it('the form keeps what was loaded, so the save can tell what changed', () => {
    const form = collectionFormFromApi({ collectionId: 'c1', handle: 'h', title: 'T', type: 'manual', ruleTag: null, productIds: ['a', 'b'], imageObjectId: 'o1', image: null, description: null });
    assert.deepEqual(form.savedProductIds, ['a', 'b']);
    assert.equal(form.imageObjectId, 'o1');
    assert.equal(form.savedImageUrl, '');
    assert.equal(membersChanged(['a', 'b'], form.savedProductIds), false);
    assert.equal(membersChanged(['b', 'a'], form.savedProductIds), true);
  });

  it('the body: a manual collection carries no tag, a smart one its tag; create is unpublished', () => {
    const manual = collectionBody({ title: 'T', handle: 'h', description: '', type: 'manual', rule: { tag: 'x' }, published: true, featured: false }, { forCreate: true });
    assert.equal(manual.ruleTag, null);
    assert.equal(manual.published, false);
    assert.equal(manual.description, null);
    const smart = collectionBody({ title: 'T', handle: 'h', type: 'smart', rule: { tag: 'Tryck' }, published: true, sortOrder: 3 }, { imageObjectId: null });
    assert.deepEqual([smart.ruleTag, smart.published, smart.sortOrder, smart.imageObjectId], ['Tryck', true, 3, null]);
    assert.equal('imageObjectId' in collectionBody({ title: 'T', handle: 'h', type: 'manual', rule: {} }), false);
  });

  it('limits are named before anything is sent', () => {
    assert.match(collectionLimitProblem({ title: 'x'.repeat(201), type: 'manual' }), /Titeln/);
    assert.equal(collectionLimitProblem({ title: 'ok', type: 'manual' }), null);
  });

  it('categories and tags are the products\' own, sorted once', () => {
    assert.deepEqual(categoriesOf([{ category: 'Hem' }, { category: ' Hem ' }, { category: null }, { category: 'Arkiv' }]), ['Arkiv', 'Hem']);
    assert.deepEqual(tagsOf([{ tags: ['b', 'a'] }, { tags: ['a', ' '] }]), ['a', 'b']);
  });
});

describe('pages', () => {
  it('a string is Swedish; empty values leave the map', () => {
    assert.deepEqual(languageMap('Hej'), { 'sv-SE': 'Hej' });
    assert.deepEqual(languageMap({ 'sv-SE': 'Hej', 'en-GB': '  ', xx_YY: 'no' }), { 'sv-SE': 'Hej' });
    assert.deepEqual(languageMap(''), {});
  });

  it('the body: maps, null for empty SEO texts, an empty paragraph for no content', () => {
    const body = pageBody({ slug: 'om', title: { 'sv-SE': 'Om' }, content: '', metaTitle: '', metaDescription: { 'sv-SE': 'D' } }, 'draft');
    assert.deepEqual(body.content, { 'sv-SE': EMPTY_CONTENT });
    assert.equal(body.metaTitle, null);
    assert.deepEqual(body.metaDescription, { 'sv-SE': 'D' });
    assert.equal(body.status, 'draft');
    assert.equal('kind' in body, false);
  });

  it('the slug is checked as the Worker checks it', () => {
    assert.equal(pageProblem({ slug: 'om-oss', title: { 'sv-SE': 'x' } }), null);
    assert.match(pageProblem({ slug: 'Om oss', title: 'x' }), /Sluggen/);
    assert.match(pageProblem({ slug: 'om-', title: 'x' }), /Sluggen/);
  });

  it('a page read back answers toDate() and keeps its maps', () => {
    const doc = pageDocFromApi({ pageId: 'p', slug: 's', status: 'published', title: { 'sv-SE': 'T' }, content: { 'sv-SE': '<p>x</p>' }, metaTitle: null, metaDescription: null, createdAt: '2026-09-10T09:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z' });
    assert.equal(doc.id, 'p');
    assert.equal(doc.updatedAt.toDate().toISOString(), '2026-09-25T09:00:00.000Z');
    assert.equal(doc.metaTitle, '');
  });

  it('a list row: the SEO maps, and the content languages stand in for the content (never its text)', () => {
    const doc = pageDocFromApi({ pageId: 'p', slug: 's', status: 'draft', title: { 'sv-SE': 'T' }, metaTitle: { 'sv-SE': 'S' }, metaDescription: null, contentLanguages: ['en-GB', 'sv-SE'] });
    assert.deepEqual(Object.keys(doc.content), ['en-GB', 'sv-SE']);
    assert.ok(Object.values(doc.content).every((v) => v.trim() === '' && v.length > 0), 'present for the status rule, no text');
    assert.deepEqual(doc.metaTitle, { 'sv-SE': 'S' });
    assert.equal(doc.metaDescription, '');
    assert.equal(pageDocFromApi({ pageId: 'p', title: {}, contentLanguages: [] }).content && Object.keys(pageDocFromApi({ pageId: 'p', title: {}, contentLanguages: [] }).content).length, 0);
    assert.equal(pageDocFromApi({ pageId: 'p', title: {} }).content, '');
    // a full page keeps its own content
    assert.deepEqual(pageDocFromApi({ pageId: 'p', title: {}, content: { 'sv-SE': '<p>x</p>' }, contentLanguages: ['sv-SE'] }).content, { 'sv-SE': '<p>x</p>' });
  });

  it('the Worker\'s refusals are said, each at its place', () => {
    assert.equal(pageRefusal({ code: 'slug_reserved' }).field, 'slug');
    assert.equal(pageRefusal({ code: 'slug_taken' }).field, 'slug');
    const refused = pageRefusal({ code: 'content_refused', details: { reason: 'script', language: 'en-GB' } });
    assert.equal(refused.field, 'content');
    assert.match(refused.message, /skript/);
    assert.match(refused.message, /en-GB/);
    assert.equal(pageRefusal({ code: 'something_else' }), null);
  });
});

describe('the identity\'s images', () => {
  const urls = new Map([['https://img.example/logo.png', 'obj-logo']]);

  it('addresses leave the patch; the object id takes their place', () => {
    const out = brandingPatch({ accent: '#000', logoUrl: 'https://img.example/logo.png', heroImageUrl: '', faviconUrl: '' }, {
      urls, loaded: { heroObjectId: { id: 'obj-hero', resolved: true } },
    });
    assert.deepEqual(out, { accent: '#000', logoObjectId: 'obj-logo', heroObjectId: null });
  });

  it('a stored id whose object is gone is cleared, one nobody touched is left', () => {
    const out = brandingPatch({ logoUrl: '/images/logo.svg' }, { urls, loaded: { logoObjectId: { id: 'x', resolved: false }, faviconObjectId: { id: 'f', resolved: true }, emailLogoObjectId: { id: 'e', resolved: false } } });
    assert.deepEqual(out, { logoObjectId: null, emailLogoObjectId: null });
  });

  it('the gallery names its images by object id', () => {
    const out = brandingPatch({ gallery: [{ imageUrl: 'https://img.example/logo.png', label: 'A', linkSku: '' }, { imageUrl: '', label: 'B' }] }, { urls, loaded: {} });
    assert.deepEqual(out.gallery, [{ label: 'A', linkSku: '', imageObjectId: 'obj-logo' }, { label: 'B' }]);
  });

  it('an image whose read failed is kept, not removed; an upload still replaces it (CP5-FX, finding 7)', () => {
    const loaded = {
      heroObjectId: { id: 'obj-hero', resolved: true, unread: true },
      faviconObjectId: { id: 'obj-fav', resolved: true, unread: true },
      logoObjectId: { id: 'obj-old-logo', resolved: true, unread: true },
    };
    // The page had no address for them: the hero and the favicon read '' and
    // the logo the default; the seller saved another field.
    const kept = brandingPatch({ accent: '#123', heroImageUrl: '', faviconUrl: '', logoUrl: '' }, { urls, loaded });
    assert.deepEqual(kept, { accent: '#123' }, 'no stored id is touched');
    const replaced = brandingPatch({ logoUrl: 'https://img.example/logo.png', heroImageUrl: '' }, { urls, loaded });
    assert.deepEqual(replaced, { logoObjectId: 'obj-logo' });
    // A preview that WAS read and then removed on the page still clears it.
    const removed = brandingPatch({ heroImageUrl: '' }, { urls, loaded: { heroObjectId: { id: 'obj-hero', resolved: true, unread: false } } });
    assert.deepEqual(removed, { heroObjectId: null });
  });

  it('a gallery image whose read failed keeps its id through the page and the save', () => {
    const saved = brandingFromIdentity(
      { gallery: [{ imageObjectId: 'g1', label: 'A' }, { imageObjectId: 'g2', label: 'B' }, { imageObjectId: 'g3', label: 'C' }] },
      { 'gallery:g1': '', 'unread:g1': 'unread', 'gallery:g2': 'https://img.example/g2.png', 'gallery:g3': '', 'gone:g3': 'gone' },
    );
    assert.deepEqual(saved.gallery, [{ label: 'A', imageObjectId: 'g1' }, { label: 'B', imageUrl: 'https://img.example/g2.png' }, { label: 'C' }]);
    const out = brandingPatch({ gallery: [...saved.gallery, { imageUrl: 'https://img.example/logo.png', imageObjectId: 'g9', label: 'D' }] }, {
      urls: new Map([...urls, ['https://img.example/g2.png', 'g2']]), loaded: {},
    });
    assert.deepEqual(out.gallery, [
      { label: 'A', imageObjectId: 'g1' },
      { label: 'B', imageObjectId: 'g2' },
      { label: 'C' },
      { label: 'D', imageObjectId: 'obj-logo' }, // replaced on the page: the upload wins
    ]);
  });

  it('the identity reads back as addresses', () => {
    const saved = brandingFromIdentity({ logoObjectId: 'obj-logo', gallery: [{ imageObjectId: 'g1', label: 'A' }, { imageObjectId: 'g2' }] }, { logoObjectId: 'https://img.example/logo.png', 'gallery:g1': 'https://img.example/g1.png', 'gallery:g2': '' });
    assert.equal(saved.logoUrl, 'https://img.example/logo.png');
    assert.deepEqual(saved.gallery, [{ label: 'A', imageUrl: 'https://img.example/g1.png' }, {}]);
  });
});
