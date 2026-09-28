// The infringement report's shapes, under Node:
//   node --test src/storefront/adapters/*.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { productRefFromLink, productRefFromPath, reportErrorKind, toReportRequest } from './report.js';
import { ApiError } from '../../api/client.js';
import { submitReport } from '../../api/reports.js';

const ORIGIN = 'https://butiker.example.test';

describe('productRefFromPath', () => {
  it('finds the product of a product page of this shop, on the shared host and on its own domain', () => {
    assert.equal(productRefFromPath('/testbutik/product/testtroja_TT-1', '/testbutik'), 'testtroja_TT-1');
    assert.equal(productRefFromPath('/testbutik/product/testtroja/', '/testbutik'), 'testtroja');
    assert.equal(productRefFromPath('/product/testtroja', ''), 'testtroja');
    assert.equal(productRefFromPath('/testbutik/product/tr%C3%B6ja', '/testbutik'), 'tröja');
  });

  it('finds nothing on another page, in another shop, or in a malformed address', () => {
    for (const [path, root] of [
      ['/testbutik/', '/testbutik'],
      ['/testbutik/produkter', '/testbutik'],
      ['/testbutik/product', '/testbutik'],
      ['/testbutik/product/a/b', '/testbutik'],
      ['/annanbutik/product/testtroja', '/testbutik'],
      ['/testbutikx/product/testtroja', '/testbutik'],
      ['/testbutik/product/%E0%A4%A', '/testbutik'],
      ['/testbutik/product/a%2Fb', '/testbutik'],
      ['/testbutik/product/%20', '/testbutik'],
      ['/testbutik/product/x', null],
      [undefined, '/testbutik'],
    ]) {
      assert.equal(productRefFromPath(path, root), null, `${path} ${root}`);
    }
  });
});

describe('productRefFromLink', () => {
  const here = { origin: ORIGIN, root: '/testbutik' };

  it('reads an address of this shop, absolute or a path', () => {
    assert.equal(productRefFromLink(`${ORIGIN}/testbutik/product/testtroja`, here), 'testtroja');
    assert.equal(productRefFromLink(`  ${ORIGIN}/testbutik/product/testtroja?x=1#y  `, here), 'testtroja');
    assert.equal(productRefFromLink('/testbutik/product/testtroja', here), 'testtroja');
  });

  it("reads nothing from another site, a product's name, or several links", () => {
    for (const text of [
      'https://annan.example.test/testbutik/product/testtroja',
      'http://butiker.example.test/testbutik/product/testtroja',
      '//annan.example.test/testbutik/product/testtroja',
      'Testtröja',
      `${ORIGIN}/testbutik/product/a ${ORIGIN}/testbutik/product/b`,
      'javascript:alert(1)',
      '',
      undefined,
    ]) {
      assert.equal(productRefFromLink(text, here), null, String(text));
    }
  });
});

describe('toReportRequest', () => {
  const form = {
    reporterName: ' Test Anmälare ',
    reporterOrg: '',
    reporterEmail: ' anmalare@example.test',
    productUrl: `${ORIGIN}/testbutik/product/testtroja `,
    rightType: 'copyright',
    description: '  Bilden på tröjan är min egen illustration från 2024.  ',
    attestation: true,
    website: '',
  };

  it('is the body the route takes, with the product named by its id', async () => {
    const body = toReportRequest(form, 'prod-a');
    assert.deepEqual(body, {
      productId: 'prod-a',
      reporterName: 'Test Anmälare',
      reporterOrg: '',
      reporterEmail: 'anmalare@example.test',
      rightType: 'copyright',
      description: 'Bilden på tröjan är min egen illustration från 2024.',
      attestation: true,
      productUrl: `${ORIGIN}/testbutik/product/testtroja`,
      website: '',
    });

    const realFetch = globalThis.fetch;
    globalThis.location = { pathname: '/testbutik/rapportera-intrang' };
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ report: { reportId: 'report-0001' } }), { status: 201 });
    };
    try {
      assert.deepEqual(await submitReport(body), { reportId: 'report-0001' });
      assert.equal(sent.url, '/_api/testbutik/v1/reports');
      // The client leaves out an empty organisation; the honeypot goes as the form holds it.
      assert.deepEqual(sent.body, {
        attestation: true,
        description: body.description,
        productId: 'prod-a',
        productUrl: body.productUrl,
        reporterEmail: body.reporterEmail,
        reporterName: body.reporterName,
        rightType: 'copyright',
        website: '',
      });
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.location;
    }
  });

  it('sends a filled honeypot as it is (the server refuses it) and the attestation only when ticked', () => {
    assert.equal(toReportRequest({ ...form, website: 'bot' }, 'prod-a').website, 'bot');
    assert.equal(toReportRequest({ ...form, attestation: 'yes' }, 'prod-a').attestation, false);
    assert.equal(toReportRequest(form, null).productId, '');
  });
});

describe('reportErrorKind', () => {
  it("maps the route's refusals to the page's texts", () => {
    const kind = (status) => reportErrorKind(new ApiError({ status, code: 'x', message: 'x' }));
    assert.equal(kind(429), 'rate_limited');
    assert.equal(kind(400), 'invalid');
    assert.equal(kind(404), 'other');
    assert.equal(kind(0), 'other');
  });
});
