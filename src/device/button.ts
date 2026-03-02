const LONG_PRESS_MS = 400;

export interface ButtonHandlers {
  onShortPress: () => void;
  onLongPressStart: () => void;
  onLongPressRelease: () => void;
}

export function createButtonHandler(handlers: ButtonHandlers) {
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let isLongPressActive = false;

  const onPress = () => {
    isLongPressActive = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      isLongPressActive = true;
      handlers.onLongPressStart();
    }, LONG_PRESS_MS);
  };

  const onRelease = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      handlers.onShortPress();
    } else if (isLongPressActive) {
      isLongPressActive = false;
      handlers.onLongPressRelease();
    }
  };

  return { onPress, onRelease };
}
