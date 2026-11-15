/**
 * What each wave brings. The first ten are written out, each one introducing
 * something: launchers, interceptors, the frigate, a bomber for the house, a
 * jammer, and at the tenth the dreadnought. After that they are generated.
 */

export interface Wave {
  drones: number;
  sams: number;
  interceptors?: number;
  bombers?: number;
  jammers?: number;
  frigate?: boolean;
  boss?: boolean;
  line: string;
}

const WAVES: readonly Wave[] = [
  { drones: 3, sams: 0, line: 'Sir, three bogeys coming over the ridge. Drone signatures.' },
  { drones: 5, sams: 0, line: 'Five more inbound. They are learning.' },
  { drones: 4, sams: 2, line: 'Surface-to-air sites are lighting up on the ridgeline. I suggest the flares. Stay where they can see you, or they will shell the house.' },
  { drones: 3, interceptors: 2, sams: 1, line: 'Fast movers, sir. Interceptors: they will not turn with you, but they will run you down.' },
  { drones: 2, sams: 1, frigate: true, line: 'A warship off the coast, sir. Guns fore and aft, a missile launcher on the foredeck. Take the radar first.' },
  { drones: 4, sams: 2, bombers: 1, line: 'A bomber, sir, and it is not here for you. It is lining up on the house.' },
  { drones: 3, interceptors: 2, jammers: 1, sams: 2, line: 'Something out there is jamming the seekers. Find the emitter and shoot it down by hand.' },
  { drones: 4, interceptors: 3, bombers: 2, sams: 3, line: 'A larger formation, sir. Shall I alert the authorities? No? Very well.' },
  { drones: 2, interceptors: 2, bombers: 1, jammers: 1, sams: 1, frigate: true, line: 'The warship is back, sir, and it has brought friends.' },
  { drones: 0, interceptors: 2, sams: 0, boss: true, line: 'Sir, that is not a drone. Something very large is coming in off the sea, and it is heading for the house.' },
];

/** What a wave brings (0 = the first): the written ones, then ever more of everything, a frigate every third and the dreadnought every fifth. */
export function waveAt(n: number): Wave {
  if (n < WAVES.length) return WAVES[n];
  const extra = n - WAVES.length + 1;
  const boss = extra % 5 === 0;
  const frigate = !boss && extra % 3 === 0;
  return {
    drones: 4 + extra,
    interceptors: 2 + Math.floor(extra / 2),
    bombers: boss ? 0 : 1 + Math.floor(extra / 3),
    jammers: extra % 2,
    sams: boss ? 1 : Math.min(6, 3 + Math.floor(extra / 2)),
    frigate,
    boss,
    line: boss ? 'Another dreadnought, sir. They do seem to have a budget.' : frigate ? 'Formation inbound, sir, and a warship standing in behind it.' : 'More of them, sir. Rather a lot more.',
  };
}
