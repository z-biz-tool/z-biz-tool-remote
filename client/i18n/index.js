const fs = require('fs');
const path = require('path');

class I18nManager {
  constructor() {
    this.currentLang = 'zh';
    this.translations = {};
    this.listeners = [];
    this.loadTranslations();
  }

  loadTranslations() {
    const i18nDir = path.join(__dirname);
    
    try {
      const files = fs.readdirSync(i18nDir);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const lang = file.replace('.json', '');
          const filePath = path.join(i18nDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          this.translations[lang] = JSON.parse(content);
        }
      });
    } catch (error) {
      console.error('Failed to load translations:', error);
    }
  }

  setLang(lang) {
    if (this.translations[lang]) {
      this.currentLang = lang;
      this.notifyListeners();
      return true;
    }
    return false;
  }

  getLang() {
    return this.currentLang;
  }

  t(key, params = {}) {
    const keys = key.split('.');
    let value = this.translations[this.currentLang];
    
    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k];
      } else {
        value = key;
        break;
      }
    }

    if (typeof value === 'string') {
      for (const [paramKey, paramValue] of Object.entries(params)) {
        value = value.replace(`{${paramKey}}`, paramValue);
      }
    }

    return value || key;
  }

  onLangChange(callback) {
    this.listeners.push(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback(this.currentLang));
  }

  getAvailableLanguages() {
    return Object.keys(this.translations);
  }
}

module.exports = new I18nManager();