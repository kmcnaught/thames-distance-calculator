// Lets the user swipe the panel down to collapse / up to expand.
//
// Native vertical scroll inside the panel body still has to win when there's
// content below the fold (otherwise Find trips / Strip would be unusable).
// Trick: snapshot `scrollable.scrollTop` at touchstart; only engage the
// collapse gesture if that snapshot was 0. If the user had already scrolled
// anywhere, this gesture does nothing and native scroll handles the drag.
//
// On an already-collapsed panel, any upward drag counts as "expand" — there
// is no scroll conflict in that direction.
//
// Thresholds: 5 px before we commit to being a gesture (lets taps and brief
// jitter through), 60 px total drag to commit to the state change.

const COLLAPSED_PEEK_PX = 80;

export function enablePanelSwipe(panel, scrollable) {
  const TRIGGER_PX = 5;
  const COMMIT_PX = 60;
  let state = null;

  function setCollapsed(collapsed) {
    panel.classList.toggle('collapsed', collapsed);
    panel.classList.toggle('expanded', !collapsed);
  }

  function onStart(e) {
    if (e.touches.length !== 1) return;
    state = {
      startY: e.touches[0].clientY,
      startScrollTop: scrollable.scrollTop,
      startCollapsed: panel.classList.contains('collapsed'),
      previewing: false,
    };
  }

  function onMove(e) {
    if (!state) return;
    const dy = e.touches[0].clientY - state.startY;

    if (state.startCollapsed) {
      if (!state.previewing && dy < -TRIGGER_PX) state.previewing = true;
      if (state.previewing) {
        e.preventDefault();
        panel.style.transform =
          `translateY(calc(100% - ${COLLAPSED_PEEK_PX}px + ${Math.min(dy, 0)}px))`;
        panel.style.transition = 'none';
      }
    } else {
      if (!state.previewing && state.startScrollTop === 0 && dy > TRIGGER_PX) {
        state.previewing = true;
      }
      if (state.previewing) {
        e.preventDefault();
        panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
        panel.style.transition = 'none';
      }
    }
  }

  function onEnd(e) {
    if (!state) return;
    const dy = (e.changedTouches[0]?.clientY ?? state.startY) - state.startY;
    panel.style.transform = '';
    panel.style.transition = '';
    if (state.previewing) {
      if (state.startCollapsed && -dy > COMMIT_PX) setCollapsed(false);
      else if (!state.startCollapsed && dy > COMMIT_PX) setCollapsed(true);
    }
    state = null;
  }

  panel.addEventListener('touchstart', onStart, { passive: true });
  panel.addEventListener('touchmove', onMove, { passive: false });
  panel.addEventListener('touchend', onEnd, { passive: true });
  panel.addEventListener('touchcancel', onEnd, { passive: true });
}
