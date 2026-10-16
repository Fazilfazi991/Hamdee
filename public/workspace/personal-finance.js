import {renderFinance,resetPersonalFinance} from './company-finance.js';
export {resetPersonalFinance};
export function renderPersonalFinance(target,options){return renderFinance(target,{...options,scope:'personal'});}
