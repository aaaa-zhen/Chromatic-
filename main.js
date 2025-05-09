const canvas = document.getElementById('webglCanvas');
const gl = canvas.getContext('webgl');

const imageUpload = document.getElementById('imageUpload');
const applyEffectButton = document.getElementById('applyEffectButton');

// Control elements
const controls = {
    colorSet1: document.getElementById('colorSet1'),
    colorSet2: document.getElementById('colorSet2'),
    colorSet3: document.getElementById('colorSet3'),
    colorSet4: document.getElementById('colorSet4'),
    colorSet5: document.getElementById('colorSet5'),
    alphaValue: document.getElementById('alphaValue'),
    displacement: document.getElementById('displacement'),
    circleCenterX: document.getElementById('circleCenterX'),
    circleCenterY: document.getElementById('circleCenterY'),
    circleRadius: document.getElementById('circleRadius'),
    feather: document.getElementById('feather')
};

let shaderProgram;
let positionBuffer;
let texCoordBuffer;
let imageTexture;
let sourceImage = new Image();
let imageLoaded = false;
let effectApplied = false;

// --- Shader Uniform Locations ---
let uImageLoc, uResolutionLoc, uColorSet1Loc, uColorSet2Loc, uColorSet3Loc, uColorSet4Loc, uColorSet5Loc;
let uAlphaValueLoc, uDisplacementLoc, uCircleCenterLoc, uCircleRadiusLoc, uFeatherLoc;

// --- Default shader parameter values (will be updated by controls) ---
let shaderParams = {
    colorSet1: [1.0, 0.0, 0.0],
    colorSet2: [0.0, 1.0, 0.0],
    colorSet3: [0.0, 0.0, 1.0],
    colorSet4: [1.0, 1.0, 0.0],
    colorSet5: [1.0, 0.0, 1.0],
    alphaValue: 0.5,
    displacement: 5.0,
    circleCenter: [200.0, 200.0], // in pixels
    circleRadius: 150.0,
    feather: 50.0
};

const MAX_CANVAS_DIMENSION = 800;

// --- Vertex Shader ---
const vsSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
    }
`;

// --- Fragment Shader (Translated from AGSL) ---
const fsSource = `
    precision mediump float;

    uniform sampler2D u_image;       // Original image (composable)
    uniform vec2 u_resolution;       // Canvas resolution (width, height)

    // ========== Original Parameters ==========
    uniform vec3 u_colorSet1;
    uniform vec3 u_colorSet2;
    uniform vec3 u_colorSet3;
    uniform vec3 u_colorSet4;
    uniform vec3 u_colorSet5;
    uniform float u_alphaValue;
    uniform float u_displacement;

    // ========== Circular Mask Parameters ==========
    uniform vec2 u_circleCenter;  // Circle center in pixel coordinates
    uniform float u_circleRadius;
    uniform float u_feather;

    varying vec2 v_texCoord; // <--- THIS WAS THE MISSING LINE

    // Helper to convert pixel displacement to normalized UV displacement
    vec2 dispToUV(float disp) {
        return vec2(disp / u_resolution.x, 0.0); // Assuming horizontal displacement only for chroma
    }

    void main() {
        // v_texCoord is normalized (0-1). gl_FragCoord is pixel coord (origin bottom-left).
        // For operations requiring pixel coords like distance to circleCenter, use gl_FragCoord.
        // Note: AGSL fragCoord might be top-left. We'll use bottom-left gl_FragCoord
        // and adjust circleCenterY if necessary during input.

        vec2 currentFragCoord = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y); // Top-left origin

        // ------------- Original Image Color -------------
        vec4 originalColor = texture2D(u_image, v_texCoord);

        // ------------- Effect Color -------------
        // 1) Chromatic Aberration
        vec3 chromaColor;
        vec2 uvDisp = dispToUV(u_displacement);
        chromaColor.r = texture2D(u_image, v_texCoord - uvDisp).r;
        chromaColor.g = originalColor.g; // Texture2D(u_image, v_texCoord).g;
        chromaColor.b = texture2D(u_image, v_texCoord + uvDisp).b;
        
        // 2) Multi-color Blending
        // AGSL's fragCoord / 1000.0 was a fixed normalization.
        // Using v_texCoord (normalized 0-1) is more standard for such effects in GLSL.
        float xNorm = v_texCoord.x; 
        float yNorm = v_texCoord.y;
        
        float w1 = (sin(xNorm * 3.14159 * 2.0) + 1.0) * 0.5;
        float w2 = (cos(yNorm * 3.14159 * 3.0) + 1.0) * 0.5;
        float w3 = (sin((xNorm + yNorm) * 3.14159) + 1.0) * 0.5;
        float w4 = (cos(xNorm * yNorm * 3.14159 * 4.0) + 1.0) * 0.5;
        // This w5 calculation does not strictly make sum of weights = 1
        // but we'll replicate the AGSL logic.
        float w5 = 1.0 - (w1 + w2 + w3 + w4) * 0.25; 
        
        vec3 blendedColor = u_colorSet1 * w1 +
                              u_colorSet2 * w2 +
                              u_colorSet3 * w3 +
                              u_colorSet4 * w4 +
                              u_colorSet5 * w5;
        
        // 3) Multiply-like blend + alphaValue
        vec3 effectColor = mix(chromaColor, chromaColor * blendedColor, u_alphaValue);

        // ------------- Circular Mask Calculation -------------
        // Distance from current fragment (pixel) to circle center
        float dist = distance(currentFragCoord, u_circleCenter);
        
        // Smoothstep for feathering
        // mask = 0 inside (circleRadius - feather) -> full effect
        // mask = 1 outside circleRadius -> full original
        float mask = smoothstep(u_circleRadius - u_feather, u_circleRadius, dist);
        
        // ------------- Mix based on mask -------------
        vec3 finalColor = mix(effectColor, originalColor.rgb, mask);
        
        gl_FragColor = vec4(finalColor, originalColor.a); // Preserve original alpha or use 1.0
    }
`;

function initWebGL() {
    if (!gl) {
        alert("Unable to initialize WebGL. Your browser may not support it.");
        return false;
    }

    shaderProgram = createShaderProgram(gl, vsSource, fsSource);
    if (!shaderProgram) return false;

    // --- Get Attribute Locations ---
    const positionAttributeLocation = gl.getAttribLocation(shaderProgram, "a_position");
    const texCoordAttributeLocation = gl.getAttribLocation(shaderProgram, "a_texCoord");

    // --- Get Uniform Locations ---
    uImageLoc = gl.getUniformLocation(shaderProgram, "u_image");
    uResolutionLoc = gl.getUniformLocation(shaderProgram, "u_resolution");
    uColorSet1Loc = gl.getUniformLocation(shaderProgram, "u_colorSet1");
    uColorSet2Loc = gl.getUniformLocation(shaderProgram, "u_colorSet2");
    uColorSet3Loc = gl.getUniformLocation(shaderProgram, "u_colorSet3");
    uColorSet4Loc = gl.getUniformLocation(shaderProgram, "u_colorSet4");
    uColorSet5Loc = gl.getUniformLocation(shaderProgram, "u_colorSet5");
    uAlphaValueLoc = gl.getUniformLocation(shaderProgram, "u_alphaValue");
    uDisplacementLoc = gl.getUniformLocation(shaderProgram, "u_displacement");
    uCircleCenterLoc = gl.getUniformLocation(shaderProgram, "u_circleCenter");
    uCircleRadiusLoc = gl.getUniformLocation(shaderProgram, "u_circleRadius");
    uFeatherLoc = gl.getUniformLocation(shaderProgram, "u_feather");

    // --- Create Buffers ---
    // Position buffer (a quad that fills the canvas)
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    // Texture coordinate buffer
    texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    const texCoords = [0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]; // Flipped Y for standard image loading
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW);

    // --- Configure Attributes ---
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.enableVertexAttribArray(texCoordAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.vertexAttribPointer(texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    return true;
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Error compiling shader:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createShaderProgram(gl, vsSource, fsSource) {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vertexShader || !fragmentShader) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Error linking program:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

function loadImageAndTexture(src) {
    imageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    // Put a single pixel in the texture so we can use it immediately.
    const level = 0;
    const internalFormat = gl.RGBA;
    const width = 1;
    const height = 1;
    const border = 0;
    const srcFormat = gl.RGBA;
    const srcType = gl.UNSIGNED_BYTE;
    const pixel = new Uint8Array([0, 0, 255, 255]); // opaque blue
    gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, width, height, border, srcFormat, srcType, pixel);

    sourceImage = new Image();
    sourceImage.onload = () => {
        // Resize canvas to image aspect ratio, capped by MAX_CANVAS_DIMENSION
        let canvasWidth = sourceImage.width;
        let canvasHeight = sourceImage.height;
        const aspectRatio = sourceImage.width / sourceImage.height;

        if (canvasWidth > MAX_CANVAS_DIMENSION || canvasHeight > MAX_CANVAS_DIMENSION) {
            if (aspectRatio > 1) { // Landscape
                canvasWidth = MAX_CANVAS_DIMENSION;
                canvasHeight = MAX_CANVAS_DIMENSION / aspectRatio;
            } else { // Portrait or square
                canvasHeight = MAX_CANVAS_DIMENSION;
                canvasWidth = MAX_CANVAS_DIMENSION * aspectRatio;
            }
        }
        canvas.width = Math.round(canvasWidth);
        canvas.height = Math.round(canvasHeight);
        
        // Update default circle center and radius based on new canvas size
        shaderParams.circleCenter = [canvas.width / 2, canvas.height / 2];
        controls.circleCenterX.value = shaderParams.circleCenter[0].toFixed(1);
        controls.circleCenterY.value = shaderParams.circleCenter[1].toFixed(1);
        
        const maxRadius = Math.max(canvas.width, canvas.height); // Allow radius to be larger
        controls.circleRadius.max = maxRadius; // Update max for the slider
        // Ensure current value is within new bounds, or set to a sensible default
        let currentRadius = parseFloat(controls.circleRadius.value);
        if (currentRadius > maxRadius) {
            currentRadius = maxRadius / 2; // Default to half of the larger dimension
        }
        shaderParams.circleRadius = currentRadius;
        controls.circleRadius.value = shaderParams.circleRadius;


        gl.bindTexture(gl.TEXTURE_2D, imageTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceImage);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        imageLoaded = true;
        applyEffectButton.disabled = false;
        if (effectApplied) { // If effect was already active, re-render
            render();
        } else {
            // Optionally draw the original image here if you want it to appear before "Apply Effect"
            // This would require a different, simpler shader.
            // For now, we just enable the button.
             gl.clearColor(0.2, 0.2, 0.2, 1.0); // A dark gray
             gl.clear(gl.COLOR_BUFFER_BIT);
        }
    };
    sourceImage.onerror = () => {
        console.error("Failed to load image.");
        alert("Error loading image.");
        applyEffectButton.disabled = true;
    };
    sourceImage.src = src;
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? [
        parseInt(result[1], 16) / 255.0,
        parseInt(result[2], 16) / 255.0,
        parseInt(result[3], 16) / 255.0
    ] : [0,0,0];
}

function updateShaderParamsFromControls() {
    shaderParams.colorSet1 = hexToRgb(controls.colorSet1.value);
    shaderParams.colorSet2 = hexToRgb(controls.colorSet2.value);
    shaderParams.colorSet3 = hexToRgb(controls.colorSet3.value);
    shaderParams.colorSet4 = hexToRgb(controls.colorSet4.value);
    shaderParams.colorSet5 = hexToRgb(controls.colorSet5.value);
    shaderParams.alphaValue = parseFloat(controls.alphaValue.value);
    shaderParams.displacement = parseFloat(controls.displacement.value);
    shaderParams.circleCenter = [
        parseFloat(controls.circleCenterX.value),
        parseFloat(controls.circleCenterY.value) // Y is already top-left from input
    ];
    shaderParams.circleRadius = parseFloat(controls.circleRadius.value);
    shaderParams.feather = parseFloat(controls.feather.value);
}

function render() {
    if (!gl || !shaderProgram || !imageLoaded) { // Removed !effectApplied check here
        if (gl && !imageLoaded) { // Only clear if no image yet
             gl.clearColor(0.2, 0.2, 0.2, 1.0);
             gl.clear(gl.COLOR_BUFFER_BIT);
        }
        return;
    }
    
    if (!effectApplied) { // If effect is not "applied", just draw original image (or clear)
        // To draw the original image, you'd need a passthrough shader.
        // For simplicity, we'll just clear or ensure the image is on a 2D canvas if desired.
        // Here, we'll ensure WebGL canvas is cleared if no effect is applied yet after image load.
        gl.clearColor(0.0, 0.0, 0.0, 0.0); // Clear to transparent to see underlying page bg
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // If you want to draw the plain image using WebGL before effect:
        // 1. Create a very simple passthrough vertex and fragment shader.
        // 2. Use that program here to draw the texture.
        // For now, the canvas will be clear or show the single blue pixel from texture init.
        // Or, better, just show the image via an <img> tag and hide it when WebGL renders.
        return; // Don't render the effect if not applied
    }


    updateShaderParamsFromControls();

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0); // Clear to transparent or black
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);


    gl.useProgram(shaderProgram);

    // --- Set Uniforms ---
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1i(uImageLoc, 0); // Texture unit 0

    gl.uniform2f(uResolutionLoc, gl.canvas.width, gl.canvas.height);

    gl.uniform3fv(uColorSet1Loc, shaderParams.colorSet1);
    gl.uniform3fv(uColorSet2Loc, shaderParams.colorSet2);
    gl.uniform3fv(uColorSet3Loc, shaderParams.colorSet3);
    gl.uniform3fv(uColorSet4Loc, shaderParams.colorSet4);
    gl.uniform3fv(uColorSet5Loc, shaderParams.colorSet5);
    gl.uniform1f(uAlphaValueLoc, shaderParams.alphaValue);
    gl.uniform1f(uDisplacementLoc, shaderParams.displacement);
    gl.uniform2fv(uCircleCenterLoc, shaderParams.circleCenter);
    gl.uniform1f(uCircleRadiusLoc, shaderParams.circleRadius);
    gl.uniform1f(uFeatherLoc, shaderParams.feather);

    gl.drawArrays(gl.TRIANGLES, 0, 6); // 6 vertices for 2 triangles (a quad)
}

// --- Event Listeners ---
imageUpload.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        effectApplied = false; // Reset effect status on new image
        const reader = new FileReader();
        reader.onload = (e) => {
            loadImageAndTexture(e.target.result);
        }
        reader.readAsDataURL(file);
    }
});

applyEffectButton.addEventListener('click', () => {
    if (imageLoaded) {
        effectApplied = true;
        render();
    }
});

// Update shader on control change if effect is active
Object.values(controls).forEach(control => {
    control.addEventListener('input', () => {
        if (effectApplied) { // Only re-render if the effect is currently active
            updateShaderParamsFromControls(); // Ensure params are fresh before render call
            render();
        }
    });
});

canvas.addEventListener('mousemove', (e) => {
    if (imageLoaded && effectApplied) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top; // Canvas Y is top-left
        
        controls.circleCenterX.value = x.toFixed(1);
        controls.circleCenterY.value = y.toFixed(1); // This is already top-left
        
        // Update shaderParams directly for immediate feedback
        // And then call render. No need to call updateShaderParamsFromControls() here
        // as mousemove should only update circleCenter.
        shaderParams.circleCenter = [x, y]; 
        render(); // Re-render with new mouse position
    }
});


// --- Initialize ---
if (initWebGL()) {
    // Set initial control values from shaderParams defaults (important for sliders etc.)
    controls.colorSet1.value = '#ff0000'; 
    controls.colorSet2.value = '#00ff00';
    controls.colorSet3.value = '#0000ff';
    controls.colorSet4.value = '#ffff00';
    controls.colorSet5.value = '#ff00ff';
    controls.alphaValue.value = shaderParams.alphaValue;
    controls.displacement.value = shaderParams.displacement;
    controls.circleCenterX.value = shaderParams.circleCenter[0].toFixed(1);
    controls.circleCenterY.value = shaderParams.circleCenter[1].toFixed(1);
    controls.circleRadius.value = shaderParams.circleRadius;
    controls.feather.value = shaderParams.feather;
    
    // Initial clear or placeholder
    gl.clearColor(0.2, 0.2, 0.2, 1.0); // A dark gray
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

} else {
    applyEffectButton.disabled = true;
    document.getElementById('controls').style.display = 'none';
    const p = document.createElement('p');
    p.textContent = "WebGL initialization failed. Please use a supported browser.";
    p.style.color = "red";
    document.body.insertBefore(p, document.getElementById('controls'));
}