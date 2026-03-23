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

// Attributes
attribute vec4 position;
attribute vec2 uvs;
//attribute vec2 uvs2;

// Uniforms
uniform mat4 matWorldViewProj;
uniform mat4 matView;
uniform mat4 matWorld;
uniform mat4 matWorldView;
uniform mat4 matWorldViewInv;

// Varying
#ifdef DIFFUSETEXTURE
varying vec2 v_texCoord;
#endif

#ifdef BLENDTEXTURE
varying vec2 v_texCoord2;
#endif

#ifdef DIFFUSEVERTEX
varying lowp vec4 v_vertexColour;
attribute lowp vec4 colourRGBA;
#endif

void main()
{ 	
	gl_Position		= position * matWorldViewProj;
	#ifdef DIFFUSETEXTURE
	v_texCoord		= uvs;
	#endif
	#ifdef BLENDTEXTURE
//	v_texCoord2		= uvs2;
	#endif	
	#ifdef DIFFUSEVERTEX
	v_vertexColour  = colourRGBA;
	#endif 
}
