// Resolve the mockup images that belong to one sellable colour variant.
// The storefront replaces the product gallery when a variant has `images`, so
// front and back must both be present here. Other print surfaces stay in the
// product gallery; they are not automatically variant views.
export const orderedVariantMockupUrls = ({
  colorwayId, mockups = [], urls = [], fallbackUrl = '',
}) => {
  const pairs = mockups.map((mockup, index) => ({ mockup, url: urls[index] })).filter((item) =>
    item.mockup?.colorwayId === colorwayId && item.url
  );
  const front = pairs.find((item) => item.mockup.slot === 'front')?.url || '';
  const back = pairs.find((item) => item.mockup.slot === 'back')?.url || '';
  const primary = front || pairs[0]?.url || fallbackUrl;
  return [...new Set([primary, back].filter(Boolean))];
};
