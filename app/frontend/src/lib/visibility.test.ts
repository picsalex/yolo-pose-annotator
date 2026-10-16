import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MODEL, type Pose, hiddenPoints, parseModel, project } from './visibility'

const model = parseModel(JSON.parse(readFileSync(new URL(`../../public/forklifts/${MODEL}.json`, import.meta.url), 'utf8')))
const cam = { W: 1920, H: 1080, f: 960 }

/** A level camera `height` m up, `dist` m away at azimuth az (0: on the truck's left, +X), looking at it. */
function camera(az: number, dist = 8, height = 5): Pose {
  const C = [dist * Math.cos(az), height, dist * Math.sin(az)]
  const fwd = [-C[0], 1 - C[1], -C[2]], n = Math.hypot(...fwd), z = fwd.map((v) => v / n)
  let x = [-z[2], 0, z[0]]
  const nx = Math.hypot(...x); x = x.map((v) => v / nx)
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const R = [...x, ...y, ...z]
  return { R, t: [0, 1, 2].map((r) => -(R[3 * r] * C[0] + R[3 * r + 1] * C[1] + R[3 * r + 2] * C[2])) }
}
const seen = (az: number) => {
  const pose = camera(az)
  const vis = hiddenPoints(model, model.roof.map((X) => project(cam, pose, X).slice(0, 2) as [number, number]), cam.W, cam.H)
  return [4, 5, 6, 7].filter((i) => vis[i])
}

// bottom corners: 4 front-left, 5 back-left, 6 back-right, 7 front-right (+X = the truck's left)
it('pre-hides the bottom corners the truck hides', () => {
  for (const az of [0, 1, 2, 3, 4, 5]) console.log(`az ${az}: visible ${seen(az)}`)
  expect(seen(0)).toEqual(expect.arrayContaining([4, 5]))               // from the left: the left corners
  expect(seen(0)).not.toContain(6); expect(seen(0)).not.toContain(7)
  expect(seen(Math.PI)).toEqual(expect.arrayContaining([6, 7]))         // from the right: the right corners
  expect(seen(Math.PI)).not.toContain(4); expect(seen(Math.PI)).not.toContain(5)
  expect(seen(-Math.PI / 2)).toEqual(expect.arrayContaining([5, 6]))    // from behind: the back corners
  expect(seen(Math.PI / 2)).toEqual(expect.arrayContaining([4, 7]))     // from the front: the front corners
})
