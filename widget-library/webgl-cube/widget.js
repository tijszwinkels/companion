export function describe(props) {
  return `${props.title}: interactive WebGL cube, yaw ${Math.round(props.yaw)}°, pitch ${Math.round(props.pitch)}°. Drag to rotate.`;
}
export const actions = {
  set_rotation(props, args) {
    props.yaw = args.yaw;
    props.pitch = args.pitch;
    return { props };
  },
};
export function mount(root, api) {
  const heading = document.createElement('h2');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Drag to rotate a WebGL cube');
  root.replaceChildren(heading, canvas);
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl) {
    const fallback = document.createElement('p');
    fallback.textContent = 'WebGL is unavailable with this graphics configuration.';
    root.append(fallback);
    return {
      update(props) {
        heading.textContent = props.title;
      },
    };
  }
  const shader = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw Error('Could not compile cube shader');
    }
    return shader;
  };
  const vertex = shader(
    gl.VERTEX_SHADER,
    `attribute vec3 position; attribute vec3 color; varying vec3 faceColor; uniform vec2 rotation; uniform float aspect;
    void main(){float a=rotation.x,b=rotation.y;vec3 p=position; p=vec3(cos(a)*p.x+sin(a)*p.z,p.y,-sin(a)*p.x+cos(a)*p.z);p=vec3(p.x,cos(b)*p.y-sin(b)*p.z,sin(b)*p.y+cos(b)*p.z); gl_Position=vec4(p.x/aspect,p.y,p.z*0.2,2.3);faceColor=color;}`,
  );
  const fragment = shader(
    gl.FRAGMENT_SHADER,
    'precision mediump float; varying vec3 faceColor; void main(){gl_FragColor=vec4(faceColor,1.0);}',
  );
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.useProgram(program);
  const vertices = [];
  const faces = [
    [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
      [0.3, 0.6, 1],
    ],
    [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [0.6, 0.4, 0.9],
    ],
    [
      [1, -1, 1],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [0.3, 0.8, 0.7],
    ],
    [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
      [0.9, 0.5, 0.5],
    ],
    [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
      [0.9, 0.7, 0.3],
    ],
    [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
      [0.6, 0.7, 0.8],
    ],
  ];
  for (const face of faces) {
    for (const index of [0, 1, 2, 0, 2, 3]) {
      vertices.push(...face[index], ...face[4]);
    }
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
  for (const [name, offset] of [
    ['position', 0],
    ['color', 12],
  ]) {
    const location = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, offset);
  }
  let yaw = 0;
  let pitch = 0;
  let dragging;
  function draw() {
    canvas.width = Math.max(100, Math.round(canvas.clientWidth));
    canvas.height = Math.max(100, Math.round(canvas.clientHeight));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform2f(
      gl.getUniformLocation(program, 'rotation'),
      (yaw * Math.PI) / 180,
      (pitch * Math.PI) / 180,
    );
    gl.uniform1f(gl.getUniformLocation(program, 'aspect'), canvas.width / canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
  }
  canvas.onpointerdown = (event) => {
    dragging = { x: event.clientX, y: event.clientY, yaw, pitch };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (dragging) {
      yaw = dragging.yaw + (event.clientX - dragging.x) * 0.7;
      pitch = dragging.pitch + (event.clientY - dragging.y) * 0.7;
      draw();
    }
  };
  canvas.onpointerup = () => {
    if (dragging) {
      dragging = null;
      void api.call('set_rotation', { yaw, pitch }).catch(() => {});
    }
  };
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  return {
    update(props) {
      heading.textContent = props.title;
      yaw = props.yaw;
      pitch = props.pitch;
      draw();
    },
    dispose() {
      observer.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
