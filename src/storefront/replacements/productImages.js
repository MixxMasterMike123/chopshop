// src/utils/productImages.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js).
//
// A product without an image gets a generated placeholder tile, as it does
// today (the pages call getProductImage when a product has no image; the API
// answers `image: null` for such a product, CP4-A review, answer 2). The
// drawing code below is the Firebase module's, unchanged. Left out: the table
// of tiles the Firebase module draws for a fixed set of product names of the
// source system's first product line when the module loads; it names the
// earlier brand and would ship it in the storefront's bundle. A name that is
// not in that table was already drawn by the same code as here.

export const generateProductImage = (productName, color = 'blue', productColorField = null) => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // Set canvas size
  canvas.width = 400;
  canvas.height = 400;

  // Colour mappings by the product's colour field.
  const colorMap = {
    'Transparent': '#64748B',
    'Röd': '#DC2626',
    'Fluorescerande': '#10B981',
    'Glitter': '#F59E0B',
    'blue': '#2563EB',
    'default': '#2563EB'
  };

  // Use productColorField if provided, otherwise fallback to legacy name parsing
  let productColor = colorMap.default;

  if (productColorField && colorMap[productColorField]) {
    productColor = colorMap[productColorField];
  } else {
    // Legacy fallback for old color parameter or name parsing
    const legacyColorMap = {
      'red': '#DC2626',
      'röd': '#DC2626',
      'transparent': '#64748B',
      'fluorescent': '#10B981',
      'fluorescerande': '#10B981',
      'glitter': '#F59E0B',
      'blue': '#2563EB'
    };

    if (typeof color === 'string' && legacyColorMap[color.toLowerCase()]) {
      productColor = legacyColorMap[color.toLowerCase()];
    } else {
      // Fallback to name parsing for backward compatibility
      Object.keys(legacyColorMap).forEach(key => {
        if (productName.toLowerCase().includes(key)) {
          productColor = legacyColorMap[key];
        }
      });
    }
  }

  // Create gradient background
  const gradient = ctx.createRadialGradient(200, 200, 0, 200, 200, 200);
  gradient.addColorStop(0, '#FFFFFF');
  gradient.addColorStop(1, '#F8FAFC');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 400, 400);

  // Draw the shape
  ctx.save();
  ctx.translate(200, 200);

  // Main shield shape
  ctx.beginPath();
  ctx.fillStyle = productColor;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;

  // Draw shield-like shape
  ctx.moveTo(0, -80);
  ctx.quadraticCurveTo(60, -60, 60, 0);
  ctx.quadraticCurveTo(60, 60, 0, 80);
  ctx.quadraticCurveTo(-60, 60, -60, 0);
  ctx.quadraticCurveTo(-60, -60, 0, -80);
  ctx.fill();

  // Add inner details
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.moveTo(0, -60);
  ctx.quadraticCurveTo(40, -45, 40, 0);
  ctx.quadraticCurveTo(40, 45, 0, 60);
  ctx.quadraticCurveTo(-40, 45, -40, 0);
  ctx.quadraticCurveTo(-40, -45, 0, -60);
  ctx.fill();

  // Neutral placeholder label: the product name's initials (up to 2 letters),
  // no hardcoded brand.
  const initials = String(productName || '')
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '•';
  ctx.fillStyle = 'white';
  ctx.font = 'bold 28px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, 0, 0);

  ctx.restore();

  // Add product name at bottom
  ctx.fillStyle = '#374151';
  ctx.font = 'bold 16px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(productName.split(' ')[0], 200, 350);

  return canvas.toDataURL('image/png');
};

// Function to get product image by name or product object
export const getProductImage = (productData) => {
  // A name (legacy usage): drawn from the name.
  if (typeof productData === 'string') {
    return generateProductImage(productData);
  }

  // If productData is an object (preferred usage), use color field
  if (productData && typeof productData === 'object') {
    const { name, color } = productData;

    // Generate image using the color field for accurate color matching
    if (color) {
      return generateProductImage(name || '', null, color);
    }

    // Fallback to name-based generation if no color field
    return generateProductImage(name || '');
  }

  // Final fallback
  return generateProductImage('');
};
