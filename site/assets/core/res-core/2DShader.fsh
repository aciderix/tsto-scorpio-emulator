/*
 *  BGCore
 *  
 *  Sources may not be modified, distributed, copied, or compiled
 *  in partial or in full, without explicit written approval from
 *  Bight Interactive Inc.
 *
 *  Copyright 2006-2011 Bight Interactive Inc. All rights reserved.
 *
 */


precision mediump float;
precision mediump int;
varying vec2 v_texCoord;

#ifdef DIFFUSETEXTURE
uniform sampler2D diffuseTexture;
#endif

#ifdef BLENDTEXTURE
uniform sampler2D blendTexture;
varying vec2 v_texCoord2;
#endif

#ifdef DIFFUSEVERTEX
varying vec4 v_vertexColour;
#endif

#ifdef DIFFUSEUNIFORM
uniform vec4 diffuseColour;
#endif

#ifdef ALPHA_TEST
uniform float gAlphaTestVal;
#endif

lowp vec4 GetDiffuseColour()
{
	lowp vec4 lColour;
	#ifdef DIFFUSETEXTURE
		lColour = texture2D(diffuseTexture, v_texCoord);
		#ifdef USING_SINGLE_COMPONENT_DIFFUSE_TEXTURE
			lColour.rgb = lowp vec3(1.0, 1.0, 1.0);
		#endif
		#ifdef DIFFUSEVERTEX
			lColour *= v_vertexColour;
		#endif
		#ifdef DIFFUSEUNIFORM
			lColour *= diffuseColour;
		#endif
	#elif defined(DIFFUSEVERTEXCOLOUR)
		lColour = v_vertexColour;
	#elif defined(DIFFUSEVERTEX)
		lColour = v_vertexColour;
	#elif defined(DIFFUSEUNIFORM)
		lColour = diffuseColour;
	#else
		lColour = lowp vec4(1.0, 1.0, 1.0, 1.0);
	#endif
	
	#ifdef BLENDTEXTURE
		lowp vec4 lBlendColour = texture2D(blendTexture, v_texCoord2);
		#ifdef USING_SINGLE_COMPONENT_BLEND_TEXTURE
			lBlendColour.rgb = lowp vec3(1.0, 1.0, 1.0);
		#endif
		lColour = lBlendColour * lColour;
	#endif
	return lColour;
}

void main()
{
	gl_FragColor = GetDiffuseColour();	
	
	#if defined (ALPHA_TEST)
	if(gl_FragColor.a < gAlphaTestVal)
		discard;
	#endif
}
