/**
 * Applies the Android transition-finalisation fix from react-native-screens
 * PR #3250 to the locked 4.26.x dependency.
 *
 * Remove this script and the package.json postinstall hook once an Expo-
 * compatible react-native-screens release contains the upstream fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screensRoot = path.join(mobileRoot, 'node_modules', 'react-native-screens', 'android', 'src', 'main', 'java', 'com', 'swmansion', 'rnscreens');
const screenPath = path.join(screensRoot, 'Screen.kt');
const stackPath = path.join(screensRoot, 'ScreenStack.kt');

function replaceExactly(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) {
    throw new Error(`Unable to apply react-native-screens patch: ${label} was not found.`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Unable to apply react-native-screens patch: ${label} was not unique.`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchScreen() {
  let source = fs.readFileSync(screenPath, 'utf8');
  if (source.includes('transitioningViews.asReversed().forEach')) return false;

  source = replaceExactly(
    source,
    '        isBeingRemoved = false\n        endTransitionRecursive(this)',
    '        isBeingRemoved = false\n        endViewTransition()',
    'Screen.endRemovalTransition call',
  );

  source = replaceExactly(
    source,
    `    private fun endTransitionRecursive(parent: ViewGroup) {
        parent.children.forEach { childView ->
            parent.endViewTransition(childView)

            if (childView is ScreenStackHeaderConfig) {
                endTransitionRecursive(childView.toolbar)
            }

            if (childView is ViewGroup) {
                endTransitionRecursive(childView)
            }
        }
    }

`,
    '',
    'obsolete recursive transition cleanup',
  );

  source = replaceExactly(
    source,
    `    private fun startTransitionRecursive(parent: ViewGroup?) {
        parent?.let {
            for (i in 0 until it.childCount) {
                val child = it.getChildAt(i)`,
    `    private val transitioningViews = mutableListOf<Pair<ViewGroup, View>>()

    private fun startTransitionRecursive(parent: ViewGroup?) {
        parent?.let { parentView ->
            for (i in 0 until parentView.childCount) {
                val child = parentView.getChildAt(i)`,
    'transition tracking declaration',
  );

  source = replaceExactly(
    source,
    '                    it.addView(View(context), i)',
    '                    parentView.addView(View(context), i)',
    'SwipeRefreshLayout transition parent',
  );

  source = replaceExactly(
    source,
    '                    child?.let { view -> it.startViewTransition(view) }',
    `                    child?.let { childView ->
                        parentView.startViewTransition(childView)
                        transitioningViews.add(Pair(parentView, childView))
                    }`,
    'transition pair capture',
  );

  source = replaceExactly(
    source,
    `    // We do not want to perform any action, therefore do not need to override the associated method.`,
    `    private fun endViewTransition() {
        // Inner children must be finalised before their parents.
        transitioningViews.asReversed().forEach { (parent, child) ->
            parent.endViewTransition(child)
        }
        transitioningViews.clear()
    }

    // We do not want to perform any action, therefore do not need to override the associated method.`,
    'reverse-order transition cleanup',
  );

  fs.writeFileSync(screenPath, source);
  return true;
}

function patchScreenStack() {
  let source = fs.readFileSync(stackPath, 'utf8');
  if (source.includes('view.fragment.screen.endRemovalTransition()')) return false;

  source = replaceExactly(
    source,
    `        super.endViewTransition(view)

        disappearingTransitioningChildren.remove(view)`,
    `        if (view is ScreensCoordinatorLayout) {
            view.fragment.screen.endRemovalTransition()
        }

        super.endViewTransition(view)

        disappearingTransitioningChildren.remove(view)`,
    'ScreenStack child-first transition cleanup',
  );

  fs.writeFileSync(stackPath, source);
  return true;
}

const patched = [patchScreen(), patchScreenStack()].some(Boolean);
console.log(patched ? 'Applied react-native-screens Android transition fix.' : 'react-native-screens Android transition fix already applied.');
