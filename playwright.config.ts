import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/ui',workers:1,timeout:30000,reporter:'list',use:{browserName:'chromium',headless:true},
  projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]});
