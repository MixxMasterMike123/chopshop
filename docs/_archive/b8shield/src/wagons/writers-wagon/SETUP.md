# The Writer's Wagon™ Setup Guide

## Overview
The Writer's Wagon™ is the first AI-powered "wagon" for the B8Shield platform, providing automated content generation for B2B and B2C product descriptions using Claude AI.

## Quick Setup

### 1. API Key Configuration
Create or update your `.env.local` file in the project root:

```bash
# Add your Claude API key
VITE_CLAUDE_API_KEY=your-claude-api-key-here
```

### 2. Test the Integration
```bash
# Start development server
npm run dev

# Navigate to test interface (if integrated)
# Or import WritersWagonTest component
```

## Architecture

### Core Files
```
src/wagons/writers-wagon/
├── api/
│   ├── WritersWagonAPI.js        # Main API manager (React-adapted)
│   ├── WritersWagonConfig.js     # Configuration and model settings
│   ├── api-manager.js            # Original API manager (reference)
│   └── config.js                 # Original config (reference)
├── components/
│   └── WritersWagonPanel.jsx     # Main React component
├── prompts/
│   └── ai-rules-system/          # AI rules and prompt management
├── WritersWagonTest.jsx          # Test interface component
├── README.md                     # Documentation
└── SETUP.md                      # This file
```

### Integration Points
- **B8Shield Admin**: Can be integrated into product management
- **Product Editing**: AI content generation for product descriptions
- **Multi-Language**: Supports Swedish (primary) + Nordic languages
- **B2B/B2C**: Separate content generation for different audiences

## Features

### Content Generation Types
1. **Dual Content** - Both B2B and B2C descriptions
2. **B2B Technical** - Professional reseller information
3. **B2C Marketing** - Consumer-focused copy
4. **Title Optimization** - SEO-optimized product titles

### AI Models Available
- **Claude 3.5 Sonnet** - Best balance of quality and cost
- **Claude 3 Haiku** - Fastest and most cost-effective

### Brand Voice Configuration
- **B8Shield Specific** - Fishing industry terminology
- **Swedish Language** - Native Swedish content generation
- **Professional Tone** - Appropriate for B2B and B2C contexts

## Usage Examples

### Basic API Usage
```javascript
import { writersWagonAPI } from './api/WritersWagonAPI.js';

// Generate dual content
const result = await writersWagonAPI.generateDualContent({
  name: 'B8Shield Original',
  size: 'Medium',
  basePrice: 149,
  description: 'Transparent protective sleeve...'
});

console.log(result.content);
```

### React Component Integration
```jsx
import WritersWagonPanel from './components/WritersWagonPanel.jsx';

function ProductEditor({ product }) {
  const [showAI, setShowAI] = useState(false);

  const handleContentGenerated = (content) => {
    // Apply generated content to product
    updateProduct({ description: content.content });
  };

  return (
    <div>
      <button onClick={() => setShowAI(true)}>
        Generate AI Content
      </button>
      
      {showAI && (
        <WritersWagonPanel
          productData={product}
          onContentGenerated={handleContentGenerated}
          onClose={() => setShowAI(false)}
        />
      )}
    </div>
  );
}
```

## Configuration Options

### Model Settings
```javascript
// In WritersWagonConfig.js
export const WRITERS_WAGON_CONFIG = {
  CURRENT_MODEL: 'claude-3-5-sonnet', // Default model
  API: {
    maxTokens: 2000,      // Max response length
    temperature: 0.3,     // Creativity level
    retryAttempts: 3,     // Error retry count
    timeout: 30000        // Request timeout
  }
};
```

### Content Type Configuration
```javascript
'b2b-technical': {
  model: 'claude-3-5-sonnet',
  maxTokens: 1500,
  temperature: 0.1,     // Very factual
  systemRole: 'technical-writer'
}
```

## Cost Management

### Estimated API Costs
- **Claude 3.5 Sonnet**: ~3 öre per 1,000 tokens
- **Claude 3 Haiku**: ~0.25 öre per 1,000 tokens
- **Typical Generation**: 500-1,500 tokens (1.5-4.5 öre per request)

### Usage Tracking
The system automatically tracks:
- Total requests and tokens
- Estimated costs per generation
- Monthly usage statistics
- Average cost per request

### Usage Limits
```javascript
USAGE: {
  trackGenerations: true,
  trackCosts: true,
  monthlyLimit: 1000,        // Request limit
  warningThreshold: 0.8      // Warn at 80%
}
```

## Error Handling

### Common Issues
1. **API Key Missing**: Check `.env.local` file
2. **Network Errors**: Automatic retry with exponential backoff
3. **Rate Limits**: Built-in throttling and retry logic
4. **Invalid Responses**: Comprehensive error messages

### Debugging
```javascript
// Enable debug logging
console.log(writersWagonAPI.getUsageStats());

// Check API key status
try {
  const apiKey = getAPIKey();
  console.log('✅ API key configured');
} catch (error) {
  console.error('❌ API key issue:', error.message);
}
```

## Integration with B8Shield

### Admin Product Management
The Writer's Wagon can be integrated into the existing `AdminProducts.jsx` component:

```jsx
// Add AI generation button to product editing
<button 
  onClick={() => setShowAIPanel(true)}
  className="flex items-center space-x-2 px-3 py-2 bg-blue-600 text-white rounded-lg"
>
  <SparklesIcon className="h-4 w-4" />
  <span>Generate AI Content</span>
</button>
```

### B2C Shop Integration
Generate consumer-focused product descriptions for the B2C storefront:

```javascript
// Automated B2C content generation
const b2cContent = await writersWagonAPI.generateB2CContent(productData);
// Apply to PublicStorefront component
```

## Security Considerations

### API Key Protection
- Store API key in `.env.local` (not committed to git)
- Use environment variables for production deployment
- Consider server-side proxy for enhanced security

### Usage Monitoring
- Monitor monthly API usage
- Set usage alerts and limits
- Track costs for budget management

## Development Workflow

### Testing
1. Use `WritersWagonTest.jsx` for standalone testing
2. Test different content types and models
3. Verify cost tracking and error handling

### Integration
1. Import `WritersWagonPanel` into existing components
2. Pass product data via props
3. Handle generated content with callback functions

### Deployment
1. Ensure API key is configured in production environment
2. Test API connectivity before deployment
3. Monitor usage and costs after launch

## Future Roadmap

### Planned Features
- **Batch Processing**: Generate content for multiple products
- **Template System**: Custom prompt templates per product category
- **Quality Scoring**: Automated content quality assessment
- **A/B Testing**: Compare different generated versions
- **Translation**: Multi-language content generation
- **Brand Voice Training**: Custom B8Shield voice fine-tuning

### Additional Wagons
The Writer's Wagon is the first of many planned AI-powered wagons:
- **Analytics Wagon**: AI-powered sales and customer insights
- **Support Wagon**: AI customer service chatbot
- **SEO Wagon**: Automated SEO optimization
- **Social Wagon**: Social media content generation

## Support & Troubleshooting

### Common Errors
- **"API key not configured"**: Add `VITE_CLAUDE_API_KEY` to `.env.local`
- **"Request timeout"**: Check network connection, retry
- **"Rate limit exceeded"**: Wait and retry, or upgrade API plan
- **"Invalid response format"**: Check Claude API version compatibility

### Getting Help
1. Check console logs for detailed error messages
2. Verify API key configuration and validity
3. Test with simple prompts first
4. Review network requests in browser dev tools

### Contact
For questions about The Writer's Wagon™ implementation or integration with B8Shield, contact the development team. 