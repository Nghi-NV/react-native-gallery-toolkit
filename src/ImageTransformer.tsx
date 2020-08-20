import React, { useRef, useMemo } from 'react';
import {
  StyleSheet,
  Image,
  ImageRequireSource,
  ViewStyle,
  Dimensions,
} from 'react-native';
import Animated, {
  withSpring,
  withTiming,
  useSharedValue,
  useAnimatedStyle,
  cancelAnimation,
  useDerivedValue,
  Easing,
  withDecay,
} from 'react-native-reanimated';
import {
  PinchGestureHandler,
  PanGestureHandler,
  TapGestureHandler,
  State,
  PanGestureHandlerGestureEvent,
  PinchGestureHandlerGestureEvent,
  TapGestureHandlerGestureEvent,
} from 'react-native-gesture-handler';
import * as vec from './vectors';
import { useAnimatedGestureHandler } from './useAnimatedGestureHandler';
import {
  fixGestureHandler,
  clamp,
  workletNoop,
  useAnimatedReaction,
} from './utils';

const styles = {
  fill: {
    ...StyleSheet.absoluteFillObject,
  },
  wrapper: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
  },
};

const springConfig = {
  stiffness: 1000,
  damping: 500,
  mass: 3,
  overshootClamping: true,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const timingConfig = {
  duration: 250,
  easing: Easing.bezier(0.33, 0.01, 0, 1),
};

type IImageTransformerProps = {
  outerGestureHandlerRefs?: React.Ref<any>[];
  source?: ImageRequireSource;
  uri?: string;
  width: number;
  height: number;
  windowDimensions: {
    width: number;
    height: number;
  };
  onStateChange?: (isActive: boolean) => void;
  ImageComponent?: React.ComponentType<any>;
  renderImage?: (props: {
    width: number;
    height: number;
    source: { uri: string } | ImageRequireSource;
  }) => React.ComponentType<any>;
  isActive?: Animated.SharedValue<boolean>;
  outerGestureHandlerActive?: Animated.SharedValue<boolean>;
  onTap?: () => void;
  onDoubleTap?: () => void;
  onInteraction?: () => void;
  style?: ViewStyle;
};

function checkIsNotUsed(handlerState: Animated.SharedValue<State>) {
  'worklet';

  return (
    handlerState.value !== State.UNDETERMINED &&
    handlerState.value !== State.END
  );
}

const AnimatedImageComponent = Animated.createAnimatedComponent(
  Image,
);

export const ImageTransformer = React.memo<IImageTransformerProps>(
  ({
    outerGestureHandlerRefs = [],
    source,
    uri,
    width,
    height,
    onStateChange = workletNoop,
    renderImage,
    windowDimensions = Dimensions.get('window'),
    isActive,
    outerGestureHandlerActive,
    style,
    onTap = workletNoop,
    onDoubleTap = workletNoop,
    onInteraction = workletNoop,
  }) => {
    fixGestureHandler();

    if (typeof source === 'undefined' && typeof uri === 'undefined') {
      throw new Error(
        'ImageTransformer: either source or uri should be passed to display an image',
      );
    }

    const imageSource = source ?? {
      uri: uri!,
    };

    const MAX_SCALE = 3;
    const MIN_SCALE = 0.7;
    const OVER_SCALE = 0.5;

    const pinchRef = useRef(null);
    const panRef = useRef(null);
    const tapRef = useRef(null);
    const doubleTapRef = useRef(null);

    const panState = useSharedValue<State>(State.UNDETERMINED);
    const pinchState = useSharedValue<State>(State.UNDETERMINED);

    const scale = useSharedValue(1);
    const scaleOffset = useSharedValue(1);
    const translation = vec.useSharedVector(0, 0);
    const panVelocity = vec.useSharedVector(0, 0);
    const scaleTranslation = vec.useSharedVector(0, 0);
    const offset = vec.useSharedVector(0, 0);

    const canvas = vec.create(
      windowDimensions.width,
      windowDimensions.height,
    );
    const targetWidth = windowDimensions.width;
    const scaleFactor = width / targetWidth;
    const targetHeight = height / scaleFactor;
    const image = vec.create(targetWidth, targetHeight);

    const canPanVertically = useDerivedValue(() => {
      return windowDimensions.height < targetHeight * scale.value;
    });

    function resetSharedState(animated?: boolean) {
      'worklet';

      if (animated) {
        scale.value = withTiming(1, timingConfig);
        scaleOffset.value = 1;

        vec.set(offset, () => withTiming(0, timingConfig));
      } else {
        scale.value = 1;
        scaleOffset.value = 1;
        vec.set(translation, 0);
        vec.set(scaleTranslation, 0);
        vec.set(offset, 0);
      }
    }

    const maybeRunOnEnd = () => {
      'worklet';

      const target = vec.create(0, 0);

      const fixedScale = clamp(MIN_SCALE, scale.value, MAX_SCALE);
      const scaledImage = image.y * fixedScale;
      const rightBoundary = (canvas.x / 2) * (fixedScale - 1);

      let topBoundary = 0;

      if (canvas.y < scaledImage) {
        topBoundary = Math.abs(scaledImage - canvas.y) / 2;
      }

      const maxVector = vec.create(rightBoundary, topBoundary);
      const minVector = vec.invert(maxVector);

      if (!canPanVertically.value) {
        offset.y.value = withSpring(target.y, springConfig);
      }

      // we should handle this only if pan or pinch handlers has been used already
      if (checkIsNotUsed(panState) || checkIsNotUsed(pinchState)) {
        return;
      }

      if (
        vec.eq(offset, 0) &&
        vec.eq(translation, 0) &&
        vec.eq(scaleTranslation, 0) &&
        scale.value === 1
      ) {
        // we don't need to run any animations
        return;
      }

      if (scale.value <= 1) {
        // just center it
        vec.set(offset, () => withTiming(0, timingConfig));
        return;
      }

      vec.set(target, vec.clamp(offset, minVector, maxVector));

      const deceleration = 0.9915;

      const isInBoundaryX = target.x === offset.x.value;
      const isInBoundaryY = target.y === offset.y.value;

      if (isInBoundaryX) {
        if (
          Math.abs(panVelocity.x.value) > 0 &&
          scale.value <= MAX_SCALE
        ) {
          offset.x.value = withDecay({
            velocity: panVelocity.x.value,
            clamp: [minVector.x, maxVector.x],
            deceleration,
          });
        }
      } else {
        offset.x.value = withSpring(target.x, springConfig);
      }

      if (isInBoundaryY) {
        if (
          Math.abs(panVelocity.y.value) > 0 &&
          scale.value <= MAX_SCALE &&
          offset.y.value !== minVector.y &&
          offset.y.value !== maxVector.y
        ) {
          offset.y.value = withDecay({
            velocity: panVelocity.y.value,
            clamp: [minVector.y, maxVector.y],
            deceleration,
          });
        }
      } else {
        offset.y.value = withSpring(target.y, springConfig);
      }
    };

    const onPanEvent = useAnimatedGestureHandler<
      PanGestureHandlerGestureEvent,
      {
        panOffset: vec.Vector<number>;
        pan: vec.Vector<number>;
      }
    >({
      onInit: (_, ctx) => {
        ctx.panOffset = vec.create(0, 0);
      },

      shouldHandleEvent: () => {
        return (
          scale.value > 1 &&
          typeof outerGestureHandlerActive !== 'undefined' &&
          !outerGestureHandlerActive.value
        );
      },

      beforeEach: (evt, ctx) => {
        ctx.pan = vec.create(evt.translationX, evt.translationY);
        const velocity = vec.create(evt.velocityX, evt.velocityY);

        vec.set(panVelocity, velocity);
      },

      onStart: (_, ctx) => {
        cancelAnimation(offset.x);
        cancelAnimation(offset.y);
        ctx.panOffset = vec.create(0, 0);
        onInteraction();
      },

      onActive: (evt, ctx) => {
        panState.value = evt.state;

        if (scale.value > 1) {
          if (evt.numberOfPointers > 1) {
            // store pan offset during the pan with two fingers (during the pinch)
            vec.set(ctx.panOffset, ctx.pan);
          } else {
            // subtract the offset and assign fixed pan
            const nextTranslate = vec.add([
              ctx.pan,
              vec.invert(ctx.panOffset),
            ]);
            translation.x.value = nextTranslate.x;

            if (canPanVertically.value) {
              translation.y.value = nextTranslate.y;
            }
          }
        }
      },

      onEnd: (evt, ctx) => {
        panState.value = evt.state;

        vec.set(ctx.panOffset, 0);
        vec.set(offset, vec.add([offset, translation]));
        vec.set(translation, 0);

        maybeRunOnEnd();

        vec.set(panVelocity, 0);
      },
    });

    useAnimatedReaction(
      () => {
        'worklet';

        if (typeof isActive === 'undefined') {
          return true;
        }

        return isActive.value;
      },
      (currentActive) => {
        'worklet';

        if (!currentActive) {
          resetSharedState();
        }
      },
    );

    const onScaleEvent = useAnimatedGestureHandler<
      PinchGestureHandlerGestureEvent,
      {
        origin: vec.Vector<number>;
        adjustFocal: vec.Vector<number>;
        gestureScale: number;
        nextScale: number;
      }
    >({
      onInit: (_, ctx) => {
        ctx.origin = vec.create(0, 0);
        ctx.gestureScale = 1;
      },

      shouldHandleEvent: (evt) => {
        return (
          evt.numberOfPointers === 2 &&
          typeof outerGestureHandlerActive !== 'undefined' &&
          !outerGestureHandlerActive.value
        );
      },

      beforeEach: (evt, ctx) => {
        // calculate the overall scale value
        // also limits this.event.scale
        ctx.nextScale = clamp(
          evt.scale * scaleOffset.value,
          MIN_SCALE,
          MAX_SCALE + OVER_SCALE,
        );

        if (
          ctx.nextScale > MIN_SCALE &&
          ctx.nextScale < MAX_SCALE + OVER_SCALE
        ) {
          ctx.gestureScale = evt.scale;
        }

        // this is just to be able to use with vectors
        const focal = vec.create(evt.focalX, evt.focalY);
        const CENTER = vec.divide([canvas, 2]);

        // focal with translate offset
        // it alow us to scale into different point even then we pan the image
        ctx.adjustFocal = vec.sub([focal, vec.add([CENTER, offset])]);
      },

      afterEach: (evt, ctx) => {
        if (evt.state === 5) {
          return;
        }

        scale.value = ctx.nextScale;
      },

      onStart: (_, ctx) => {
        onInteraction();
        cancelAnimation(offset.x);
        cancelAnimation(offset.y);
        vec.set(ctx.origin, ctx.adjustFocal);
      },

      onActive: (evt, ctx) => {
        pinchState.value = evt.state;

        const pinch = vec.sub([ctx.adjustFocal, ctx.origin]);

        const nextTranslation = vec.add([
          pinch,
          ctx.origin,
          vec.multiply([-1, ctx.gestureScale, ctx.origin]),
        ]);

        vec.set(scaleTranslation, nextTranslation);
      },

      onEnd: (evt, ctx) => {
        // reset gestureScale value
        ctx.gestureScale = 1;
        pinchState.value = evt.state;
        // store scale value
        scaleOffset.value = scale.value;

        vec.set(offset, vec.add([offset, scaleTranslation]));
        vec.set(scaleTranslation, 0);

        if (scaleOffset.value < 1) {
          // make sure we don't add stuff below the 1
          scaleOffset.value = 1;

          // this runs the spring animation
          scale.value = withTiming(1, timingConfig);
        } else if (scaleOffset.value > MAX_SCALE) {
          scaleOffset.value = MAX_SCALE;
          scale.value = withTiming(MAX_SCALE, timingConfig);
        }

        maybeRunOnEnd();
      },
    });

    const onTapEvent = useAnimatedGestureHandler({
      shouldHandleEvent: (evt) => {
        return (
          evt.numberOfPointers === 1 &&
          typeof outerGestureHandlerActive !== 'undefined' &&
          !outerGestureHandlerActive.value
        );
      },

      onStart: () => {
        cancelAnimation(offset.x);
        cancelAnimation(offset.y);
      },

      onActive: () => {
        onTap();
      },

      onEnd: () => {
        maybeRunOnEnd();
      },
    });

    function handleScaleTo(x: number, y: number) {
      'worklet';

      const FUTURE_SCALE = 3;

      scale.value = withTiming(FUTURE_SCALE, timingConfig);
      scaleOffset.value = FUTURE_SCALE;

      const targetImageSize = vec.multiply([image, FUTURE_SCALE]);

      const CENTER = vec.divide([canvas, 2]);
      const imageCenter = vec.divide([image, 2]);

      const focal = vec.create(x, y);

      const origin = vec.multiply([
        -1,
        vec.sub([vec.divide([targetImageSize, 2]), CENTER]),
      ]);

      const koef = vec.sub([
        vec.multiply([vec.divide([1, imageCenter]), focal]),
        1,
      ]);

      const target = vec.multiply([origin, koef]);

      offset.x.value = withTiming(target.x, timingConfig);
      offset.y.value = withTiming(target.y, timingConfig);
    }

    const onDoubleTapEvent = useAnimatedGestureHandler<
      TapGestureHandlerGestureEvent,
      {}
    >({
      shouldHandleEvent: (evt) => {
        return (
          evt.numberOfPointers === 1 &&
          typeof outerGestureHandlerActive !== 'undefined' &&
          !outerGestureHandlerActive.value
        );
      },

      onActive: ({ x, y }) => {
        onDoubleTap();

        if (scale.value > 1) {
          resetSharedState(true);
        } else {
          handleScaleTo(x, y);
        }
      },
    });

    const animatedStyles = useAnimatedStyle<ViewStyle>(() => {
      const noOffset = offset.x.value === 0 && offset.y.value === 0;
      const noTranslation =
        translation.x.value === 0 && translation.y.value === 0;
      const noScaleTranslation =
        scaleTranslation.x.value === 0 &&
        scaleTranslation.y.value === 0;

      // FIXME: We should not stick to pager with naming
      const isInactive =
        scale.value === 1 &&
        noOffset &&
        noTranslation &&
        noScaleTranslation;

      onStateChange(isInactive);

      return {
        transform: [
          {
            translateX:
              scaleTranslation.x.value +
              translation.x.value +
              offset.x.value,
          },
          {
            translateY:
              scaleTranslation.y.value +
              translation.y.value +
              offset.y.value,
          },
          { scale: scale.value },
        ],
      };
    });

    return (
      <Animated.View style={[styles.container, { width }, style]}>
        <PinchGestureHandler
          ref={pinchRef}
          onGestureEvent={onScaleEvent}
          simultaneousHandlers={[
            panRef,
            tapRef,
            ...outerGestureHandlerRefs,
          ]}
        >
          <Animated.View style={styles.fill}>
            <PanGestureHandler
              ref={panRef}
              minDist={10}
              avgTouches
              simultaneousHandlers={[
                pinchRef,
                tapRef,
                ...outerGestureHandlerRefs,
              ]}
              onGestureEvent={onPanEvent}
            >
              <Animated.View style={styles.fill}>
                <TapGestureHandler
                  ref={tapRef}
                  numberOfTaps={1}
                  maxDeltaX={8}
                  maxDeltaY={8}
                  simultaneousHandlers={[
                    pinchRef,
                    panRef,
                    ...outerGestureHandlerRefs,
                  ]}
                  waitFor={doubleTapRef}
                  onGestureEvent={onTapEvent}
                >
                  <Animated.View style={[styles.fill]}>
                    <Animated.View style={styles.fill}>
                      <Animated.View style={styles.wrapper}>
                        <TapGestureHandler
                          ref={doubleTapRef}
                          numberOfTaps={2}
                          maxDelayMs={140}
                          maxDeltaX={16}
                          maxDeltaY={16}
                          simultaneousHandlers={[
                            pinchRef,
                            panRef,
                            ...outerGestureHandlerRefs,
                          ]}
                          onGestureEvent={onDoubleTapEvent}
                        >
                          <Animated.View style={animatedStyles}>
                            {typeof renderImage === 'function' ? (
                              renderImage({
                                imageSource,
                                width: targetWidth,
                                height: targetHeight,
                              })
                            ) : (
                              <AnimatedImageComponent
                                source={imageSource}
                                style={{
                                  width: targetWidth,
                                  height: targetHeight,
                                }}
                              />
                            )}
                          </Animated.View>
                        </TapGestureHandler>
                      </Animated.View>
                    </Animated.View>
                  </Animated.View>
                </TapGestureHandler>
              </Animated.View>
            </PanGestureHandler>
          </Animated.View>
        </PinchGestureHandler>
      </Animated.View>
    );
  },
);