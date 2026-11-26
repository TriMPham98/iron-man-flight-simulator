import * as THREE from 'three';

/**
 * Two guards on three's own lit materials against black specks in the HDR
 * frame (the terrain, the trees, the suit and the drones under the
 * reticle and the tapes). Imported for its side effect before any program
 * compiles; three resolves its chunks at compile time.
 *
 * - With MSAA a sample on a triangle's edge can sit outside the triangle,
 *   and its varyings are then extrapolated, not interpolated: on a tree a
 *   few pixels across, a dark trunk's vertex colour beside a lit crown's
 *   runs well below zero. Centroid sampling keeps vColor inside.
 * - Whatever still comes out below zero is held at zero per sample, so it
 *   can only darken its pixel's MSAA average, never drive it to black.
 */
const C = THREE.ShaderChunk as Record<string, string>;
const DONE = '/* shader-guards */';

if (!C.opaque_fragment.includes(DONE)) {
  for (const k of ['color_pars_vertex', 'color_pars_fragment']) {
    C[k] = C[k].replaceAll('varying vec', 'centroid varying vec');
  }
  C.normal_fragment_begin = C.normal_fragment_begin
    .replace(
      'vec3 normal = normalize( cross( fdx, fdy ) );',
      'vec3 _flatN = cross( fdx, fdy );\nvec3 normal = dot( _flatN, _flatN ) > 1e-12 ? normalize( _flatN ) : vec3( 0.0, 0.0, 1.0 );',
    )
    .replace(
      'vec3 normal = normalize( vNormal );',
      'vec3 normal = dot( vNormal, vNormal ) > 1e-12 ? normalize( vNormal ) : vec3( 0.0, 0.0, 1.0 );',
    );
  C.lights_fragment_begin = `if (!(dot(normal, normal) > 1e-12)) normal = vec3(0.0, 0.0, 1.0);\n${C.lights_fragment_begin.replace(
    'normalize( vViewPosition )',
    '( dot( vViewPosition, vViewPosition ) > 1e-12 ? normalize( vViewPosition ) : vec3( 0.0, 0.0, 1.0 ) )',
  )}`;
  C.lights_fragment_end = `${C.lights_fragment_end}
#define _GUARD_TERM(t) { float _s = (t).r + (t).g + (t).b; if (!(_s >= 0.0 && _s < 60000.0)) (t) = vec3(0.0); else (t) = max((t), vec3(0.0)); }
_GUARD_TERM(reflectedLight.directDiffuse)
_GUARD_TERM(reflectedLight.indirectDiffuse)
_GUARD_TERM(reflectedLight.directSpecular)
_GUARD_TERM(reflectedLight.indirectSpecular)
#undef _GUARD_TERM
{
  vec3 _sp = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
  float _sm = max(_sp.r, max(_sp.g, _sp.b));
  if (_sm > 8.0) {
    float _sc = (8.0 + log2(1.0 + _sm - 8.0)) / _sm;
    reflectedLight.directSpecular *= _sc;
    reflectedLight.indirectSpecular *= _sc;
  }
}`;
  C.opaque_fragment = `${DONE}
float _ogSum = outgoingLight.r + outgoingLight.g + outgoingLight.b;
if (!(_ogSum >= 0.0 && _ogSum < 180000.0)) outgoingLight = max(diffuseColor.rgb * 0.25, vec3(0.0));
outgoingLight = max(outgoingLight, vec3(0.0));
${C.opaque_fragment}`;
}
