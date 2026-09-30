/**
 * Plugin styles, injected once. Tokens only — no invented CSS variables, no
 * hardcoded greys — so both themes follow the app without a second definition.
 *
 * The dimming in follow mode is `opacity`, not a colour: it has to read as "this
 * line is further away", and it must land the same way on a light and a dark
 * background.
 */
const CSS = `
.transcribe-view{display:flex;flex-direction:column;min-height:100%;color:var(--text-color)}
.transcribe-header{height:var(--app-bar-height);flex:0 0 auto;box-sizing:border-box;min-width:0;display:flex;align-items:center;justify-content:space-between;padding:0 calc(var(--plugin-actions-offset, 0px) + 10px) 0 calc(var(--plugin-navigation-offset, 0px) + 10px);border-bottom:1px solid var(--border-light);gap:8px}
.transcribe-header strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.transcribe-segments{display:flex;flex-direction:column;padding:8px;gap:6px}
.transcribe-segment{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;text-align:left;padding:9px;border:1px solid var(--border-light);border-radius:7px;background:var(--container-color);color:var(--text-color)}
.transcribe-segment:hover{background:var(--hover-bg)}
.transcribe-file,.transcribe-time,.transcribe-language{font-size:0.75rem;color:var(--text-secondary)}
.transcribe-file{grid-column:1/-1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.transcribe-text{line-height:1.4}.transcribe-language{grid-column:2}
.transcribe-empty{padding:12px;margin:0;color:var(--text-secondary)}

/* The panel body owns its own gutter — core gives .right-panel-body vertical
   padding only, so without this every control sat flush against both edges of
   the sidebar. Compounded with .right-panel-body (0,2,0) so it wins over the
   core rule whatever order the injected sheet lands in. */
.transcribe-meta.right-panel-body{display:flex;flex-direction:column;gap:10px;padding:var(--space-2) var(--space-3) var(--space-3);overflow:hidden}
/* One pane owns the remaining height so only the transcript scrolls: the tab
   strip and the search field must not leave with it. */
.transcribe-meta-pane{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow-y:auto}
/* Nothing in a pane stretches or squeezes by default — in a column that would
   mean height, and every control here has the height it wants. The transcript
   list is the single exception: it takes the slack and scrolls inside it. */
.transcribe-meta-pane > *{flex:none}
.transcribe-meta-pane > .transcribe-meta-lines{flex:1;min-height:0}
.transcribe-meta-pane--text{overflow:hidden}
/* Layout only — the settings kit's Segmented owns the frame, type and states. */
.transcribe-meta-tabs{flex:none}
.transcribe-meta-tabs .settings-segmented{display:flex;width:100%}
.transcribe-meta-tabs .settings-segmented-option{flex:1}
.transcribe-meta-select{width:100%}
.transcribe-meta-buttons{display:flex;align-items:center;gap:6px;flex:none}

.transcribe-search{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;border:1px solid var(--border-medium);border-radius:6px;background:var(--surface-color);color:var(--text-color)}
.transcribe-search:focus-within{border-color:var(--accent-color)}
.transcribe-search-icon{flex:none;font-size:14px;color:var(--text-secondary)}
.transcribe-search-input{flex:1;min-width:0;border:none;outline:none;background:none;color:inherit;font:inherit;padding:0}
.transcribe-search-input::placeholder{color:var(--text-tertiary)}
.transcribe-search-count{flex:none;font-size:0.6875rem;font-variant-numeric:tabular-nums;color:var(--text-secondary)}
.transcribe-search-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;border-radius:4px;background:none;color:var(--text-secondary);font-size:0.75rem}
.transcribe-search-clear:hover{background:var(--hover-bg);color:var(--text-color)}
.transcribe-meta-hit{background:var(--accent-tint-bg);color:inherit;border-radius:2px;padding:0 1px}
/* flex:none, not flex:1 — the button is a child of the pane's *column* now, so
   growing means growing in height, and it swallowed the whole pane. */
.transcribe-meta-run{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;font:inherit;padding:5px 10px;border:1px solid var(--border-medium);border-radius:6px;background:var(--surface-color);color:var(--text-color)}
.transcribe-meta-run:hover:not(:disabled){background:var(--hover-bg)}
.transcribe-meta-run:disabled{opacity:.5}
.transcribe-meta-follow{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;font-size:0.9375rem;border:1px solid var(--border-medium);border-radius:6px;background:var(--surface-color);color:var(--text-secondary)}
.transcribe-meta-follow:hover{background:var(--hover-bg)}
.transcribe-meta-follow.is-on{border-color:var(--accent-color);color:var(--accent-color)}

.transcribe-meta-progress{display:flex;flex-direction:column;gap:4px;flex:none}
.transcribe-meta-bar{height:3px;border-radius:2px;background:var(--border-light);overflow:hidden}
.transcribe-meta-bar-fill{height:100%;width:0;border-radius:2px;background:var(--accent-color);transition:width .2s linear}
/* No percentage yet: use the standard indeterminate sweep until Whisper's
   frame bar has measured enough work for a real percentage and countdown. */
.transcribe-meta-bar-fill[data-indeterminate]{width:35%;animation:transcribe-bar-indeterminate 1.25s ease-in-out infinite}
.transcribe-meta-stage{font-size:0.75rem;color:var(--text-secondary)}
.transcribe-meta-error{margin:0;font-size:0.75rem;color:var(--negative-color,var(--text-color))}
.transcribe-meta-hint{margin:0;font-size:0.75rem;color:var(--text-secondary)}
.transcribe-meta-link{appearance:none;border:0;padding:0;background:none;color:var(--accent-color);font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}

.transcribe-meta-lines{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}
.transcribe-meta-line{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:baseline;text-align:left;padding:5px 6px;border:none;border-radius:5px;background:none;color:var(--text-color);font:inherit;line-height:1.45;transition:opacity .15s ease}
.transcribe-meta-line:hover{background:var(--hover-bg)}
.transcribe-meta-line.is-dim{opacity:.38}
/* The lit background alone marks the spoken line — no accent rule down the
   left edge, which read as a selection marker rather than as playback. */
.transcribe-meta-line.is-current{background:var(--hover-bg)}
.transcribe-meta-time{font-variant-numeric:tabular-nums;font-size:0.75rem;color:var(--text-secondary);background:var(--hover-bg);padding:2px 3px;border-radius:4px}
.transcribe-meta-line.is-current .transcribe-meta-time{color:var(--accent-color)}
.transcribe-provenance{font-size:0.75rem;color:var(--text-secondary);flex:none}

/* Footer chip. The pulsing dot is the only thing that says "still running" when
   the percentage is unknown — a model download reports nothing for its first
   seconds, and a static label there reads as a stuck job. */
.transcribe-footer{display:inline-flex;align-items:center;gap:6px;max-width:240px;padding:0;border:none;background:none;color:inherit;font:inherit;font-size:inherit}
.transcribe-footer:hover{color:var(--title-color)}
.transcribe-footer-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--accent-color);animation:transcribe-footer-pulse 1.6s ease-in-out infinite}
.transcribe-footer-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
@keyframes transcribe-footer-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes transcribe-bar-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
@media (prefers-reduced-motion:reduce){.transcribe-footer-dot,.transcribe-meta-bar-fill[data-indeterminate]{animation:none}.transcribe-meta-bar-fill[data-indeterminate]{width:100%;opacity:.25}}

.transcribe-settings .transcribe-slider-row{display:flex;align-items:center;gap:var(--space-2);width:min(380px,100%)}
.transcribe-settings .transcribe-slider{flex:1;min-width:120px}
.transcribe-settings .transcribe-slider-value{flex:none;min-width:92px;text-align:right;color:var(--text-secondary)}

`

export function injectStyles(): () => void {
  const id = 'transcribe-plugin-styles'
  const existing = document.getElementById(id)
  if (existing) {
    existing.textContent = CSS
    return () => {
      if (document.getElementById(id) === existing) existing.remove()
    }
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    if (document.getElementById(id) === style) style.remove()
  }
}
