// Campaign Wagon™ - Utility Functions
// Helper functions for campaign management, banners, and affiliate targeting

import { CampaignWagonManifest } from '../CampaignWagonManifest.js';
import { APP_URLS } from '../../../config/urls';
import { resolveShopId } from '../../../config/tenancy';

// Shop path prefix for the CURRENT storefront context (mirrors the private
// helper in utils/productUrls.js).
const currentShopPrefix = () =>
  typeof window !== 'undefined' ? `/${resolveShopId(window.location.pathname)}` : '';

// **CRITICAL NOTE: affiliate URLs use the /{shopId}/ path-prefix grammar**
// Example: shop-meteorpr.web.app/{shopId}/?ref=AFFILIATE_CODE&campaign=CAMPAIGN_CODE

// Social Media Platform Banner Specifications
export const BANNER_PLATFORMS = CampaignWagonManifest.config.banners.platforms;

// Campaign Types and Their Properties
export const CAMPAIGN_TYPES = {
  competition: {
    name: 'Tävling',
    description: 'Lottery-style competition where purchases = tickets',
    icon: 'TrophyIcon',
    requiresProducts: true,
    supportsLottery: true
  },
  offer: {
    name: 'Erbjudande', 
    description: 'Special discount or promotion',
    icon: 'TagIcon',
    requiresProducts: false,
    supportsLottery: false
  },
  product_launch: {
    name: 'Produktlansering',
    description: 'New product launch campaign',
    icon: 'RocketLaunchIcon',
    requiresProducts: true,
    supportsLottery: false
  },
  special_discount: {
    name: 'Specialrabatt',
    description: 'Limited time discount campaign',
    icon: 'PercentBadgeIcon',
    requiresProducts: false,
    supportsLottery: false
  },
  seasonal: {
    name: 'Säsongskampanj',
    description: 'Seasonal marketing campaign',
    icon: 'CalendarIcon',
    requiresProducts: false,
    supportsLottery: true
  }
};

// Campaign Status Colors and Properties
export const CAMPAIGN_STATUS = {
  draft: {
    name: 'Utkast',
    color: 'gray',
    bgColor: 'bg-gray-100',
    textColor: 'text-gray-800',
    borderColor: 'border-gray-200'
  },
  active: {
    name: 'Aktiv',
    color: 'green',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800', 
    borderColor: 'border-green-200'
  },
  paused: {
    name: 'Pausad',
    color: 'yellow',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    borderColor: 'border-yellow-200'
  },
  completed: {
    name: 'Avslutad',
    color: 'blue',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-800',
    borderColor: 'border-blue-200'
  },
  cancelled: {
    name: 'Avbruten',
    color: 'red',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    borderColor: 'border-red-200'
  }
};

/**
 * Generate campaign-specific affiliate URL.
 *
 * Uses the configured storefront host + the /{shopId} path-prefix grammar, the
 * same as generateAffiliateLink in utils/productUrls.js. (Until 2026-08-15 this
 * hardcoded the dead `shop.b8shield.com` host AND the retired /se|/gb|/us
 * country-prefix grammar, so every URL it produced was doubly broken.)
 *
 * @param {string} affiliateCode - Affiliate's unique code
 * @param {string} campaignCode - Campaign's unique code
 * @returns {string} Complete campaign URL
 */
export const generateCampaignURL = (affiliateCode, campaignCode) => {
  const shopPrefix = currentShopPrefix();
  return `${APP_URLS.B2C_SHOP}${shopPrefix}/?ref=${affiliateCode}&campaign=${campaignCode}`;
};

/**
 * Generate QR code data for campaign URL
 * 
 * @param {string} campaignURL - Generated campaign URL
 * @returns {object} QR code configuration
 */
export const generateQRCodeData = (campaignURL) => {
  return {
    value: campaignURL,
    size: 256,
    level: 'M', // Error correction level
    includeMargin: true,
    bgColor: '#FFFFFF',
    fgColor: '#000000'
  };
};

/**
 * Validate banner file for platform requirements
 * 
 * @param {File} file - Banner image file
 * @param {string} platform - Target platform (e.g., 'instagram_post')
 * @returns {object} Validation result
 */
export const validateBannerFile = (file, platform) => {
  const platformSpec = BANNER_PLATFORMS[platform];
  
  if (!platformSpec) {
    return {
      valid: false,
      error: `Okänd plattform: ${platform}`
    };
  }
  
  // Check file size (5MB max)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    return {
      valid: false,
      error: 'Filen är för stor. Max 5MB tillåtet.'
    };
  }
  
  // Check file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: 'Felaktigt filformat. Endast JPG, PNG och WebP tillåtet.'
    };
  }
  
  return {
    valid: true,
    platformSpec,
    recommendedSize: `${platformSpec.width}x${platformSpec.height}px`
  };
};

/**
 * Get campaign status badge properties
 * 
 * @param {string} status - Campaign status
 * @returns {object} Badge styling properties
 */
export const getStatusBadge = (status) => {
  return CAMPAIGN_STATUS[status] || CAMPAIGN_STATUS.draft;
};

/**
 * Calculate campaign performance metrics
 * 
 * @param {object} campaign - Campaign data
 * @param {array} participants - Campaign participants
 * @returns {object} Performance metrics
 */
export const calculateCampaignMetrics = (campaign, participants = []) => {
  const totalClicks = campaign.totalClicks || 0;
  const totalConversions = participants.filter(p => p.orderId).length;
  const totalRevenue = participants.reduce((sum, p) => sum + (p.conversionValue || 0), 0);
  const conversionRate = totalClicks > 0 ? (totalConversions / totalClicks * 100) : 0;
  
  return {
    totalClicks,
    totalConversions,
    totalRevenue,
    conversionRate: Math.round(conversionRate * 100) / 100,
    totalParticipants: participants.length,
    avgOrderValue: totalConversions > 0 ? Math.round(totalRevenue / totalConversions) : 0
  };
};

/**
 * Generate lottery tickets based on product SKUs
 * Each product SKU in an order = 1 lottery ticket
 * 
 * @param {array} orderItems - Order items with SKUs
 * @returns {number} Number of lottery tickets
 */
export const calculateLotteryTickets = (orderItems = []) => {
  return orderItems.reduce((tickets, item) => {
    // Each product SKU gives 1 ticket, multiplied by quantity
    return tickets + (item.quantity || 1);
  }, 0);
};

/**
 * Filter affiliates based on campaign targeting
 * 
 * @param {array} allAffiliates - All available affiliates
 * @param {object} campaign - Campaign configuration
 * @returns {array} Filtered affiliates
 */
export const getTargetedAffiliates = (allAffiliates = [], campaign = {}) => {
  if (!campaign.selectedAffiliates || campaign.selectedAffiliates === 'all') {
    return allAffiliates.filter(affiliate => affiliate.status === 'active');
  }
  
  if (campaign.selectedAffiliates === 'none') {
    return [];
  }
  
  if (campaign.selectedAffiliates === 'selected' && campaign.affiliateIds) {
    return allAffiliates.filter(affiliate => 
      affiliate.status === 'active' && 
      campaign.affiliateIds.includes(affiliate.id)
    );
  }
  
  return [];
};

/**
 * Format campaign date range for display
 * 
 * @param {Date|string} startDate - Campaign start date
 * @param {Date|string} endDate - Campaign end date
 * @returns {string} Formatted date range
 */
export const formatCampaignDateRange = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  const options = { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    locale: 'sv-SE'
  };
  
  if (start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString('sv-SE', options);
  }
  
  return `${start.toLocaleDateString('sv-SE', options)} - ${end.toLocaleDateString('sv-SE', options)}`;
};

/**
 * Generate unique campaign code
 * 
 * @param {string} name - Campaign name
 * @returns {string} URL-safe campaign code
 */
export const generateCampaignCode = (name) => {
  const cleanName = name
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 15);
  
  const timestamp = Date.now().toString().slice(-4);
  return `${cleanName}${timestamp}`;
};

/**
 * Check if campaign is currently active
 * 
 * @param {object} campaign - Campaign data
 * @returns {boolean} Whether campaign is active
 */
export const isCampaignActive = (campaign) => {
  if (campaign.status !== 'active') return false;
  
  const now = new Date();
  const start = new Date(campaign.startDate);
  const end = new Date(campaign.endDate);
  
  return now >= start && now <= end;
};

/**
 * Check if an order matches a campaign's criteria
 * 
 * @param {object} orderData - Order data from Firestore
 * @param {object} campaign - Campaign configuration
 * @param {string} affiliateCode - Affiliate code from order
 * @returns {boolean} Whether order matches campaign
 */
export const doesOrderMatchCampaign = (orderData, campaign, affiliateCode) => {
  // Campaign must be active
  if (!isCampaignActive(campaign)) return false;
  
  // Check affiliate targeting
  if (campaign.selectedAffiliates === 'selected') {
    // Must have specific affiliate assigned to campaign
    if (!campaign.affiliateIds || campaign.affiliateIds.length === 0) return false;
    
    // Find affiliate by code to get ID
    // Note: This requires the affiliate ID to be passed or looked up
    // For now, we'll check if the affiliate is in the campaign
    // This will need to be enhanced with actual affiliate ID lookup
  }
  
  // Check product targeting
  if (campaign.applicableProducts === 'selected' && campaign.productIds) {
    // Order must contain at least one targeted product
    const orderProductIds = orderData.items?.map(item => item.id) || [];
    const hasMatchingProduct = campaign.productIds.some(productId => 
      orderProductIds.includes(productId)
    );
    if (!hasMatchingProduct) return false;
  }
  
  // Check campaign code requirement
  if (campaign.code) {
    // If campaign has a specific code, order must use that code
    const orderAffiliateCode = orderData.affiliateCode || orderData.affiliate?.code;
    if (orderAffiliateCode !== affiliateCode) return false;
  }
  
  return true;
};

/**
 * Find matching campaigns for an order and affiliate
 * 
 * @param {object} orderData - Order data from Firestore
 * @param {string} affiliateId - Affiliate ID
 * @param {string} affiliateCode - Affiliate code
 * @param {array} activeCampaigns - List of active campaigns
 * @returns {array} Matching campaigns sorted by commission rate (highest first)
 */
export const findMatchingCampaigns = (orderData, affiliateId, affiliateCode, activeCampaigns = []) => {
  const matchingCampaigns = activeCampaigns.filter(campaign => {
    // Check affiliate targeting
    if (campaign.selectedAffiliates === 'selected') {
      if (!campaign.affiliateIds || !campaign.affiliateIds.includes(affiliateId)) {
        return false;
      }
    }
    
    // Check if order matches campaign criteria
    return doesOrderMatchCampaign(orderData, campaign, affiliateCode);
  });
  
  // Sort by commission rate (highest first) to prioritize best campaigns
  return matchingCampaigns.sort((a, b) => (b.customAffiliateRate || 0) - (a.customAffiliateRate || 0));
};

/**
 * Calculate complex multi-tier commission structure
 * Handles: Customer Discount → Affiliate Commission → Campaign Revenue Share
 * 
 * @param {object} orderData - Order data from Firestore
 * @param {object} affiliate - Affiliate data (the one who brought the customer)
 * @param {object} campaign - Campaign data (product-specific revenue share)
 * @param {number} vatRate - VAT rate (default 0.25 for Sweden)
 * @returns {object} Complex commission breakdown
 */
export const calculateComplexCommission = (orderData, affiliate, campaign = null, vatRate = 0.25) => {
  const originalTotal = orderData.total || orderData.subtotal || 0;
  const shipping = orderData.shipping || 0;
  const discountAmount = orderData.discountAmount || 0;
  
  // Step 1: Calculate base product value (after customer discount, excluding shipping)
  const productValueWithVAT = Math.max(0, originalTotal - shipping);
  const productValueExcludingVAT = productValueWithVAT / (1 + vatRate);
  const vatAmount = productValueWithVAT - productValueExcludingVAT;
  
  // Step 2: Calculate affiliate commission (from discounted price, excluding VAT)
  const affiliateRate = (affiliate.commissionRate || 20) / 100;
  const affiliateCommission = Math.round((productValueExcludingVAT * affiliateRate) * 100) / 100;
  
  // Step 3: Calculate remaining amount after affiliate commission
  const remainingAfterAffiliate = productValueExcludingVAT - affiliateCommission;
  
  // Step 4: Calculate campaign revenue share (if applicable)
  let campaignShare = 0;
  let companyShare = remainingAfterAffiliate;
  
  if (campaign && campaign.isRevenueShare && remainingAfterAffiliate > 0) {
    const shareRate = (campaign.revenueShareRate || 50) / 100;
    campaignShare = Math.round((remainingAfterAffiliate * shareRate) * 100) / 100;
    companyShare = remainingAfterAffiliate - campaignShare;
  }
  
  return {
    // Original amounts
    originalTotal,
    shipping,
    discountAmount,
    
    // VAT breakdown
    productValueWithVAT,
    productValueExcludingVAT,
    vatAmount,
    
    // Commission breakdown
    affiliateCommission,
    campaignShare,
    companyShare,
    
    // Rates used
    affiliateRate: affiliate.commissionRate || 20,
    campaignShareRate: campaign?.revenueShareRate || 0,
    
    // Calculation steps for transparency
    calculationSteps: {
      step1_customerDiscount: discountAmount,
      step2_priceAfterDiscount: productValueWithVAT,
      step3_vatDeducted: vatAmount,
      step4_baseForCommissions: productValueExcludingVAT,
      step5_affiliateCommission: affiliateCommission,
      step6_remainingForShare: remainingAfterAffiliate,
      step7_campaignShare: campaignShare,
      step8_companyShare: companyShare
    },
    
    // Summary
    totalCommissionsAndShares: affiliateCommission + campaignShare,
    netCompanyRevenue: companyShare
  };
};

/**
 * Get default campaign data structure
 * 
 * @returns {object} Default campaign object
 */
export const getDefaultCampaign = () => {
  return {
    // Multilingual content (ContentTranslation pattern)
    name: {
      'sv-SE': '',
      'en-GB': '',
      'en-US': ''
    },
    description: {
      'sv-SE': '',
      'en-GB': '',
      'en-US': ''
    },
    affiliateInfo: {
      'sv-SE': '',
      'en-GB': '',
      'en-US': ''
    },
    
    // Campaign identity
    code: '',
    type: 'offer',
    status: 'draft',
    
    // Targeting
    selectedAffiliates: 'all',
    affiliateIds: [],
    
    // Pricing
    customAffiliateRate: 15,
    customerDiscountRate: 10,
    
    // Revenue sharing (for product-specific campaigns)
    isRevenueShare: false,
    revenueShareRate: 50, // Percentage of remaining amount after affiliate commission
    revenueShareType: 'fixed_percentage', // or 'sliding_scale'
    
    // Social media assets
    banners: {},
    
    // Competition features
    isLottery: false,
    lotteryRules: {
      'sv-SE': '',
      'en-GB': '',
      'en-US': ''
    },
    maxParticipants: null,
    
    // Product scope
    applicableProducts: 'all',
    productIds: [],
    
    // Analytics
    totalClicks: 0,
    totalConversions: 0,
    totalRevenue: 0,
    
    // Dates
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    
    // System fields
    createdAt: new Date(),
    createdBy: null,
    updatedAt: new Date()
  };
};