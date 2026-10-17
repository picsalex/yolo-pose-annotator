import { expect, it } from 'vitest'
import { type ForkliftAnn, KEYPOINTS, exportForklift, fromRoof } from './forklift'

const roof: [number, number][] = [[100, 100], [100, 50], [160, 50], [160, 100]]

it('a new forklift hangs its 4 bottom corners below the roof corners', () => {
  const kp = fromRoof(roof)
  expect(KEYPOINTS).toBe(8)
  expect(kp).toHaveLength(8)
  expect(kp.slice(0, 4)).toEqual(roof)
  for (let i = 4; i < KEYPOINTS; i++) {
    expect(kp[i][0]).toBe(roof[i - 4][0])
    expect(kp[i][1]).toBeGreaterThan(roof[i - 4][1])
  }
})

it('exports 8 keypoints, hidden or outside as 0 0 0, inside the box', () => {
  const kp = fromRoof(roof)
  kp[7] = [-5, 120]
  const ann: ForkliftAnn = { id: 'a', kp, vis: { 5: false } }
  const { bbox, keypoints } = exportForklift(ann, 640, 480)
  expect(keypoints).toHaveLength(8)
  expect(keypoints[7]).toEqual([0, 0, 0])
  expect(keypoints[5]).toEqual([0, 0, 0])
  expect(bbox[0]).toBe(0)
  for (const [x, y, v] of keypoints) if (v) expect(x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]).toBe(true)
  expect(exportForklift({ ...ann, box: [50, -10, 700, 300] }, 640, 480).bbox).toEqual([50, 0, 640, 300])   // a box set by hand, clipped
})
