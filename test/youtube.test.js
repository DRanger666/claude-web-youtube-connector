import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsInRange, videoId } from '../src/youtube.js';

test('videoId accepts the usual URL forms and a bare ID', () => {
  for (const video of [
    'https://www.youtube.com/watch?v=DStYkSO4Cc0&list=PLBfV7qhH_6R0&index=32',
    'https://youtu.be/DStYkSO4Cc0?t=60',
    'https://www.youtube.com/shorts/DStYkSO4Cc0',
    'https://www.youtube.com/live/DStYkSO4Cc0',
    ' DStYkSO4Cc0 ',
  ]) assert.equal(videoId(video), 'DStYkSO4Cc0');
});

test('videoId refuses anything else', () => {
  assert.throws(() => videoId('https://example.com/watch'), /Not a YouTube video URL or ID/);
  assert.throws(() => videoId('short'), /Not a YouTube video URL or ID/);
});

test('eventsInRange keeps events that start inside a half-open range', () => {
  const events = [0, 59_999, 60_000, 119_000, 120_000].map((tStartMs) => ({ tStartMs }));
  const starts = (list) => list.map((event) => event.tStartMs);
  assert.deepEqual(starts(eventsInRange(events, 60, 120)), [60_000, 119_000]);
  assert.deepEqual(starts(eventsInRange(events, undefined, 60)), [0, 59_999]);
  assert.deepEqual(starts(eventsInRange(events)), starts(events));
});
