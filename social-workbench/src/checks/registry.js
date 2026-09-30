// 所有驗證項目的清單（順序＝報告與說明的順序）
import { commonChecks } from './common.js';
import { facebookChecks } from './facebook.js';
import { instagramChecks } from './instagram.js';
import { aiChecks } from './ai.js';

export const CHECKS = { ...commonChecks, ...facebookChecks, ...instagramChecks, ...aiChecks };
