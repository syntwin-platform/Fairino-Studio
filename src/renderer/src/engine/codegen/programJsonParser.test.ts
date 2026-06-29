import { describe, expect, it } from 'vitest'

import { parseProgramJson } from './programJsonParser'

describe('parseProgramJson', () => {
  it('parses and sorts a valid Swagger program request', () => {
    const result = parseProgramJson(
      JSON.stringify({
        name: 'Swagger Program',
        status: 'Draft',
        source: 'BackendGenerated',
        steps: [
          {
            orderIndex: 2,
            stepType: 'RotateJoint',
            label: 'Rotate joint 3',
            payload: {
              jointIndex: 2,
              angle: 45,
              speed: 20,
              acc: 25
            }
          },
          {
            orderIndex: 1,
            stepType: 'MoveJ',
            label: 'Home',
            payload: {
              jointAngles: [0, -58.5, 93.6, -149.6, -90.2, 0],
              speed: 30,
              acc: 40
            }
          },
          {
            orderIndex: 3,
            stepType: 'WaitMs',
            label: 'Wait',
            payload: {
              delayMs: 1000
            }
          }
        ]
      })
    )

    expect(result.projectName).toBe('Swagger Program')
    expect(result.diagnostics).toEqual([])
    expect(result.steps).toHaveLength(3)

    expect(result.steps[0]).toMatchObject({
      id: 'step_json_1',
      type: 'MoveJ',
      label: 'Home',
      jointAngles: [0, -58.5, 93.6, -149.6, -90.2, 0],
      speed: 30,
      acc: 40
    })

    // Backend uses 0..5, while the UI uses 1..6.
    expect(result.steps[1]).toMatchObject({
      id: 'step_json_2',
      type: 'RotateJoint',
      jointIndex: 3,
      angle: 45,
      rotateMode: 'absolute',
      speed: 20,
      acc: 25
    })

    expect(result.steps[2]).toMatchObject({
      type: 'WaitMs',
      delayMs: 1000
    })
  })

  it('parses MoveL, MoveTCP and SetDO payloads', () => {
    const result = parseProgramJson(
      JSON.stringify({
        name: 'Payload test',
        steps: [
          {
            orderIndex: 1,
            stepType: 'MoveL',
            label: 'Linear move',
            payload: {
              tcpPose: {
                x: 100,
                y: 200,
                z: 300,
                rx: 180,
                ry: 0,
                rz: 90
              },
              speed: 40,
              acc: 35
            }
          },
          {
            orderIndex: 2,
            stepType: 'MoveTCP',
            label: 'TCP move',
            payload: {
              tcpPose: {
                x: 110,
                y: 210,
                z: 310,
                rx: 180,
                ry: 0,
                rz: 90
              },
              speed: 55,
              acc: 45
            }
          },
          {
            orderIndex: 3,
            stepType: 'SetDO',
            label: 'Enable output',
            payload: {
              doType: 'cabinet',
              doIndex: 2,
              doValue: 1
            }
          }
        ]
      })
    )

    expect(result.diagnostics).toEqual([])

    expect(result.steps[0]).toMatchObject({
      type: 'MoveL',
      tcpPose: {
        x: 100,
        y: 200,
        z: 300,
        rx: 180,
        ry: 0,
        rz: 90
      },
      speed: 40,
      acc: 35
    })

    expect(result.steps[1]).toMatchObject({
      type: 'MoveTCP',
      moveMode: 'absolute',
      speed: 55,
      acc: 45
    })

    expect(result.steps[2]).toMatchObject({
      type: 'SetDO',
      doType: 'cabinet',
      doIndex: 2,
      doValue: 1
    })
  })

  it('reports malformed JSON', () => {
    const result = parseProgramJson('{"name":"broken",}')

    expect(result.steps).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].path).toBe('$')
  })

  it('rejects MoveJ without six joint angles', () => {
    const result = parseProgramJson(
      JSON.stringify({
        name: 'Invalid MoveJ',
        steps: [
          {
            orderIndex: 1,
            stepType: 'MoveJ',
            label: 'Invalid',
            payload: {
              jointAngles: [0, 1, 2],
              speed: 30,
              acc: 30
            }
          }
        ]
      })
    )

    expect(result.steps).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        path: 'steps[0]',
        message: 'MoveJ jointAngles must contain exactly 6 numbers.'
      }
    ])
  })

  it('reports duplicate order indexes', () => {
    const result = parseProgramJson(
      JSON.stringify({
        name: 'Duplicate order',
        steps: [
          {
            orderIndex: 1,
            stepType: 'WaitMs',
            label: 'Wait one',
            payload: { delayMs: 100 }
          },
          {
            orderIndex: 1,
            stepType: 'WaitMs',
            label: 'Wait two',
            payload: { delayMs: 200 }
          }
        ]
      })
    )

    expect(result.diagnostics).toContainEqual({
      path: 'steps',
      message: 'Duplicate orderIndex: 1.'
    })
  })

  it('requires speed and acc for motion steps', () => {
    const result = parseProgramJson(
      JSON.stringify({
        name: 'Missing speed',
        steps: [
          {
            orderIndex: 1,
            stepType: 'MoveJ',
            label: 'Missing speed',
            payload: {
              jointAngles: [0, -58.5, 93.6, -149.6, -90.2, 0]
            }
          }
        ]
      })
    )

    expect(result.steps).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        path: 'steps[0]',
        message: 'speed must be a finite number.'
      }
    ])
  })
})
