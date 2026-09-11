/**
 * Keeps a viewport-fixed bottom element above the iOS keyboard. With document
 * scroll, Safari pans the layout viewport when the keyboard opens and
 * `fixed; bottom: 0` lands behind it; the visual viewport reports the truth.
 * Lift = layout height − visual height − visual offset: zero whenever the two
 * viewports agree (desktop, Android, keyboard closed, toolbar animations), so
 * the style is inert everywhere except an open overlay keyboard.
 */
import { useEffect, useState, type CSSProperties } from 'react';

export function useKeyboardLift(): CSSProperties {
  const [lift, setLift] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }
    const update = () => {
      const heightDeficit = window.innerHeight - viewport.height;
      if (heightDeficit < 50) {
        setLift(0);
        return;
      }
      setLift(Math.max(0, Math.round(heightDeficit - Math.max(0, viewport.offsetTop))));
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return lift > 0 ? { transform: `translateY(-${lift}px)` } : {};
}
