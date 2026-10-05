export const PIPELINE_VERSION = 2;
export const generationPresets = {
  fast: {model: 'gemini-3.8-flash-low', effort: 'low'},
  balanced: {model: 'gemini-3.8-flash-medium', effort: 'medium'},
  careful: {model: 'gemini-3.1-pro-high', effort: 'high'}
};
export const defaultGeneration = generationPresets.fast;
export function generationOptions(value = defaultGeneration) {
  if (!value || !Object.values(generationPresets).some(p => p.model === value.model && p.effort === value.effort)) throw new Error('Choose a generation speed in Your profile.');
  return {...value};
}
export function timingSummary(timings = {}) {
  return [['model_ms', 'Drafting'], ['render_ms', 'Resume PDF'], ['export_ms', 'Export']]
    .filter(([key]) => Number.isFinite(timings[key]))
    .map(([key, label]) => `${label}: ${(timings[key] / 1000).toFixed(1)}s`).join(' · ');
}
export const progressLabels = {starting_model: 'Starting Antigravity', model_working: 'Preparing content', drafting: 'Writing drafts', rendering: 'Compiling resume PDF', exporting: 'Saving PDFs'};
