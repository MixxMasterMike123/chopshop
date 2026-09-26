# AI Rules System v2.0 - Global Configuration Architecture

## 🎯 Overview

The AI Rules System is a revolutionary approach to managing AI rules in the Auctionet extension. Instead of having ~2000+ lines of scattered, duplicated AI rules across 6+ files, we now have a **single source of truth** that works like `package.json` for AI rules.

## 🚀 Key Benefits

### Before (Technical Debt Crisis)
- **2000+ lines** of scattered AI rules across multiple files
- **No single source of truth** - rules conflict and override each other
- **Impossible to debug** - can't find which rule caused issues
- **Impossible to maintain** - changing one rule requires hunting through multiple files
- **Massive code duplication** with slight variations
- **Rule conflicts** where different files have different versions of same rule

### After (Clean Architecture)
- **Single JSON configuration file** - like package.json for AI rules
- **Global access system** - available automatically to all files
- **Performance optimized** - loaded once, cached in memory
- **Hot reloading capability** - update rules without restarting
- **Validation and consistency checks** - prevent configuration errors
- **Developer experience** - IntelliSense, type safety, easy debugging
- **Version controlled** - track rule changes like code changes

## 📁 Architecture

```
modules/refactored/ai-rules-system/
├── ai-rules-config.json      # The "package.json" for AI rules
├── ai-rules-manager.js       # Global access system
├── README.md                 # This documentation
└── migration-guide.md        # Step-by-step migration guide
```

## 🔧 Core Components

### 1. AI Rules Configuration (`ai-rules-config.json`)
The master configuration file containing all AI rules:

```json
{
  "version": "2.0.0",
  "systemPrompts": { ... },
  "categoryRules": { ... },
  "fieldRules": { ... },
  "validationRules": { ... },
  "promptTemplates": { ... }
}
```

### 2. AI Rules Manager (`ai-rules-manager.js`)
Global singleton providing automatic access to all rules:

```javascript
// Automatic global access - no imports needed!
const systemPrompt = getSystemPrompt('core');
const categoryRules = getCategoryRules('weapons');
const titleRules = getTitleRules(hasArtist);
```

## 🎨 Usage Examples

### Basic Usage
```javascript
// Get system prompts
const corePrompt = getCorePrompt();
const titleCorrectPrompt = getTitleCorrectPrompt();

// Get category-specific rules
const weaponRules = getCategoryRules('weapons');
const watchRules = getCategoryRules('watches');

// Build complete prompts
const prompt = buildPrompt({
    type: 'core',
    category: 'weapons',
    fields: ['title', 'description']
});
```

### Advanced Usage
```javascript
// Check for forbidden words
if (isForbiddenWord('fantastisk')) {
    // Handle forbidden word
}

// Apply brand corrections
const correctedTitle = applyBrandCorrections('ikea stol');
// Result: "IKEA stol"

// Get field-specific rules
const titleRules = getFieldRules('title');
const maxLength = titleRules.maxLength; // 60
```

### Integration Example
```javascript
// Before: Scattered rules in multiple files
function getSystemPrompt() {
    return "Du är en professionell auktionskatalogiserare..."; // 100+ lines
}

// After: Clean global access
function enhanceItem(itemData) {
    const prompt = buildPrompt({
        type: 'addItems',
        category: itemData.category,
        fields: ['all']
    });
    
    return callAI(prompt.systemPrompt, prompt.userPrompt, itemData);
}
```

## 🔄 Migration Strategy

### Phase 1: Foundation (CURRENT)
✅ Create AI Rules Configuration (`ai-rules-config.json`)  
✅ Create Global Access System (`ai-rules-manager.js`)  
✅ Add to manifest.json for Chrome extension loading  

### Phase 2: Extract from api-manager.js (NEXT)
- Extract `getSystemPrompt()` (~100 lines)
- Extract `getUserPrompt()` (~400 lines)  
- Extract `getCategorySpecificRules()` (~200 lines)
- Update all references to use global system
- **Result: ~700 lines removed from api-manager.js**

### Phase 3: Extract from content.js
- Extract duplicate AI rules system
- Remove `getSystemPrompt()`, `getUserPrompt()`, `generatePromptForAddItems()`
- **Result: ~300 lines removed from content.js**

### Phase 4: Extract from add-items-tooltip-manager.js
- Extract `getEditPageSystemPrompt()`, `getEditPageUserPrompt()`
- **Result: ~200 lines removed from add-items-tooltip-manager.js**

### Phase 5: Extract from quality-analyzer.js
- Extract quality analysis rules and validation logic
- **Result: ~300 lines removed from quality-analyzer.js**

### Phase 6: Extract from remaining files
- Extract from brand-validation-manager.js
- Extract from core/ai-analysis-engine.js
- Extract from artist-detection-manager.js
- **Result: ~400 lines removed from various files**

### **TOTAL IMPACT: ~1900 lines removed from codebase!**

## 🛠️ Implementation Details

### Global Access Pattern
The system uses a singleton pattern with global convenience functions:

```javascript
// Singleton instance
const manager = getAIRulesManager();

// Convenience functions (auto-available globally)
const prompt = getSystemPrompt('core');
const rules = getCategoryRules('weapons');
```

### Performance Optimization
- **Lazy loading**: Rules loaded on first access
- **Memory caching**: Frequently accessed rules cached in memory
- **Single fetch**: JSON loaded once, reused throughout application
- **Hot reloading**: Update rules without restarting extension

### Error Handling
```javascript
// Graceful fallbacks
const prompt = getSystemPrompt('nonexistent'); // Falls back to 'core'
const rules = getCategoryRules('unknown'); // Returns null, logs info

// Validation on load
const validation = manager.validateConfiguration();
if (!validation.valid) {
    console.error('Configuration errors:', validation.errors);
}
```

## 📋 Configuration Sections

### System Prompts
Core AI instructions for different contexts:
- `core`: Base cataloging instructions
- `titleCorrect`: Title correction specific rules
- `addItems`: Add items enhancement rules

### Category Rules
Category-specific rules and anti-hallucination measures:
- `weapons`: Critical anti-hallucination for weapons/militaria
- `watches`: Required fields and function clauses
- `historical`: Conservative approach for historical items
- `jewelry`: Technical limitations for precious metals

### Field Rules
Field-specific formatting and validation:
- `title`: Length limits, capitalization, punctuation
- `description`: Content inclusion/exclusion rules
- `condition`: Physical state focus, damage terminology
- `keywords`: Format and duplication rules

### Validation Rules
Content validation and quality control:
- `forbiddenWords`: Sales language to avoid
- `antiHallucination`: Prevent AI from inventing information
- `uncertaintyMarkers`: Preserve uncertainty indicators
- `quotesPreservation`: Protect Swedish design names

## 🔍 Debugging and Monitoring

### Debug Information
```javascript
// Get system statistics
const manager = getAIRulesManager();
console.log(manager.getRulesStats());
// Output: "systemPrompts: 3, categoryRules: 4, fieldRules: 4, ..."

// Validate configuration
const validation = manager.validateConfiguration();
console.log('Valid:', validation.valid);
console.log('Errors:', validation.errors);

// Export for inspection
const config = manager.exportConfiguration();
console.log('Current config:', config);
```

### Hot Reloading
```javascript
// Reload rules during development
await manager.reload();
console.log('Rules reloaded successfully');
```

## 🚀 Future Enhancements

### Planned Features
- **Rule versioning**: Track rule changes over time
- **A/B testing**: Test different rule configurations
- **Performance metrics**: Monitor rule effectiveness
- **Visual editor**: GUI for editing rules
- **Rule templates**: Predefined rule sets for different use cases

### Extensibility
The system is designed to be easily extensible:
- Add new rule categories
- Extend validation rules
- Add new prompt templates
- Integrate with external rule sources

## 🎯 Success Metrics

### Technical Debt Reduction
- **~1900 lines removed** from scattered files
- **6+ files simplified** and made maintainable
- **Single source of truth** established
- **Zero rule conflicts** after migration

### Developer Experience
- **Instant access** to all rules from any file
- **IntelliSense support** for rule properties
- **Easy debugging** with centralized logging
- **Hot reloading** for rapid development

### Performance Improvements
- **Faster loading** with cached rules
- **Reduced memory usage** with singleton pattern
- **Better error handling** with validation
- **Consistent behavior** across all components

## 📞 Support

For questions about the AI Rules System:
1. Check this documentation
2. Review the migration guide
3. Examine the configuration file structure
4. Test with the provided examples

The AI Rules System represents a fundamental shift from scattered technical debt to clean, maintainable architecture. It's the foundation for scalable AI rule management in the Auctionet extension. 