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


precision mediump int;

// Attributes
attribute highp vec4 position;
attribute vec2 uvs;

#ifdef DIFFUSEVERTEX
attribute lowp vec4 colourRGBA;
#endif

// Uniforms
uniform mat4 matWorldViewProj;
uniform mat4 matView;
uniform mat4 matWorld;
uniform mat4 matWorldView;
uniform mat4 matWorldViewInv;

// Varying
#ifdef DIFFUSETEXTURE
varying vec2 v_texCoord;
#elif defined(BLENDTEXTURE)
varying vec2 v_texCoord;
#endif

#ifdef DIFFUSEVERTEX
varying lowp vec4 v_vertexColour;
#endif

void main()
{ 
	gl_Position		= vec4(position.xyz, 1) * matWorldViewProj;

	#ifdef DIFFUSETEXTURE
		v_texCoord = uvs;
	#elif defined BLENDTEXTURE
		v_texCoord = uvs;
	#endif
	#ifdef DIFFUSEVERTEX
		v_vertexColour = colourRGBA;
	#endif
}
