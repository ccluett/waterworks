/**
 * fluidSimulation.js
 * LBM with airfoil barrier. Plots velocity magnitude rather than curl.
 */

class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hasInitialized = false;
        this.options = options;
        this.currentAngle = 0; 

        // Dimensions
        this.width = canvas.width;
        this.height = canvas.height;
        this.pxPerSquare = options.pxPerSquare || 1;
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        // LBM constants
        this.four9ths = 4.0 / 9.0;
        this.one9th = 1.0 / 9.0;
        this.one36th = 1.0 / 36.0;

        // Simulation parameters
        this.flowSpeed = options.flowSpeed || 0.2;
        this.flowAngle = (options.flowAngleDeg || 0) * Math.PI / 180;
        this.viscosity = options.viscosity || 0.01;
        this.running = true;

        // Arrays
        this.initArrays();

        // imageData for rendering
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        // Initialize color map
        if (!this.colors) {
            this.initColors();
        }

        // 1) Initialize domain at rest
        this.initFluid();

        // 2) Add the airfoil barrier (zero out fluid in barrier cells)
        this.addNACABarrier({
            chordFraction: 1/4,
            thickness: 0.12,
            angle: this.currentAngle
        });

        // 3) Start simulation
        this.update();
    }

    initArrays() {
        const size = this.xdim * this.ydim;
        this.n0  = new Float32Array(size);
        this.nN  = new Float32Array(size);
        this.nS  = new Float32Array(size);
        this.nE  = new Float32Array(size);
        this.nW  = new Float32Array(size);
        this.nNE = new Float32Array(size);
        this.nSE = new Float32Array(size);
        this.nNW = new Float32Array(size);
        this.nSW = new Float32Array(size);
        this.rho = new Float32Array(size);
        this.ux  = new Float32Array(size);
        this.uy  = new Float32Array(size);

        // We'll also store speed if you like, or compute on the fly
        this.speed = new Float32Array(size);

        this.barriers = new Uint8Array(size);
    }

    initFluid() {
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                // rest: (u=0), density=1
                this.setEquilibrium(x, y, 0, 0, 1);
            }
        }
    }

    updateAngle(newAngle) {
        this.currentAngle = newAngle;
        this.initArrays();
        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/3.5,
            thickness: 0.12,
            angle: this.currentAngle
        });
    }

    initColors() {
        this.nColors = 400;
        this.colors = new Array(this.nColors);
        for (let i = 0; i < this.nColors; i++) {
            const phase = i / this.nColors;
            let r, g, b;

            if (phase < 0.125) {
                r = 0; g = 0;
                b = Math.round(255 * (phase + 0.125) / 0.25);
            } else if (phase < 0.375) {
                r = 0;
                g = Math.round(255 * (phase - 0.125) / 0.25);
                b = 255;
            } else if (phase < 0.625) {
                r = Math.round(255 * (phase - 0.375) / 0.25);
                g = 255;
                b = 255 - r;
            } else if (phase < 0.875) {
                r = 255;
                g = Math.round(255 * (0.875 - phase) / 0.25);
                b = 0;
            } else {
                r = Math.round(255 * (1.125 - phase) / 0.25);
                g = 0; b = 0;
            }
            this.colors[i] = { r, g, b };
        }
    }

    setEquilibrium(x, y, ux, uy, rho) {
        const i = x + y * this.xdim;
        const ux3 = 3 * ux;
        const uy3 = 3 * uy;
        const ux2 = ux * ux;
        const uy2 = uy * uy;
        const uxuy2 = 2 * ux * uy;
        const u2 = ux2 + uy2;
        const u215 = 1.5 * u2;

        this.n0[i]  = this.four9ths * rho * (1 - u215);
        this.nE[i]  = this.one9th   * rho * (1 + ux3 + 4.5*ux2 - u215);
        this.nW[i]  = this.one9th   * rho * (1 - ux3 + 4.5*ux2 - u215);
        this.nN[i]  = this.one9th   * rho * (1 + uy3 + 4.5*uy2 - u215);
        this.nS[i]  = this.one9th   * rho * (1 - uy3 + 4.5*uy2 - u215);
        this.nNE[i] = this.one36th  * rho * (1 + ux3 + uy3 + 4.5*(u2+uxuy2) - u215);
        this.nSE[i] = this.one36th  * rho * (1 + ux3 - uy3 + 4.5*(u2-uxuy2) - u215);
        this.nNW[i] = this.one36th  * rho * (1 - ux3 + uy3 + 4.5*(u2-uxuy2) - u215);
        this.nSW[i] = this.one36th  * rho * (1 - ux3 - uy3 + 4.5*(u2+uxuy2) - u215);

        this.rho[i] = rho;
        this.ux[i]  = ux;
        this.uy[i]  = uy;
    }

    addNACABarrier({ chordFraction = 1/3, thickness = 0.12, angle = 0 }) {
        const chordLength = Math.floor(this.xdim * chordFraction);
        const centerX = Math.floor(this.xdim / 3);
        const centerY = Math.floor(this.ydim / 2);

        const nacaThickness = (xFrac) => {
            return (thickness / 0.2) * chordLength * (
                0.2969 * Math.sqrt(xFrac) -
                0.1260 * xFrac -
                0.3516 * xFrac**2 +
                0.2843 * xFrac**3 -
                0.1015 * xFrac**4
            );
        };

        const cosAng = Math.cos(angle);
        const sinAng = Math.sin(angle);

        for (let i = 0; i <= chordLength; i++) {
            const xFrac = i / chordLength;
            const halfThick = nacaThickness(xFrac);

            const xTop = Math.round(centerX + i * cosAng - halfThick * sinAng);
            const yTop = Math.round(centerY + i * sinAng + halfThick * cosAng);
            const xBot = Math.round(centerX + i * cosAng + halfThick * sinAng);
            const yBot = Math.round(centerY + i * sinAng - halfThick * cosAng);

            this.fillBarrierLine(xTop, yTop, xBot, yBot);
        }

        // Zero out fluid in barrier cells
        for (let idx = 0; idx < this.barriers.length; idx++) {
            if (this.barriers[idx] === 1) {
                this.n0[idx]  = 0;  this.nN[idx]  = 0;  this.nS[idx]  = 0;
                this.nE[idx]  = 0;  this.nW[idx]  = 0;  this.nNE[idx] = 0;
                this.nSE[idx] = 0;  this.nNW[idx] = 0;  this.nSW[idx] = 0;

                this.rho[idx] = 0; 
                this.ux[idx]  = 0;  
                this.uy[idx]  = 0;
            }
        }
    }

    fillBarrierLine(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);

        for (let s = 0; s <= steps; s++) {
            const frac = s / steps;
            const x = Math.round(x1 + frac * dx);
            const y = Math.round(y1 + frac * dy);
            const idx = x + y * this.xdim;
            if (idx >= 0 && idx < this.barriers.length) {
                this.barriers[idx] = 1;
            }
        }
    }

    setBoundaryConditions() {
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);

        // Inlet on left (if cosA >= 0) or right (if cosA < 0)
        if (cosA >= 0) {
            // left boundary
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
            // right boundary "copy"
            for (let y = 0; y < this.ydim; y++) {
                const iRight = (this.xdim - 1) + y * this.xdim;
                const i2 = (this.xdim - 2) + y * this.xdim;
                this.n0[iRight]  = this.n0[i2];
                this.nN[iRight]  = this.nN[i2];
                this.nS[iRight]  = this.nS[i2];
                this.nE[iRight]  = this.nE[i2];
                this.nW[iRight]  = this.nW[i2];
                this.nNE[iRight] = this.nNE[i2];
                this.nSE[iRight] = this.nSE[i2];
                this.nNW[iRight] = this.nNW[i2];
                this.nSW[iRight] = this.nSW[i2];
            }
        } else {
            // right boundary: set velocity
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
            // left boundary "copy"
            for (let y = 0; y < this.ydim; y++) {
                const iLeft = 0 + y * this.xdim;
                const i2 = 1 + y * this.xdim;
                this.n0[iLeft]  = this.n0[i2];
                this.nN[iLeft]  = this.nN[i2];
                this.nS[iLeft]  = this.nS[i2];
                this.nE[iLeft]  = this.nE[i2];
                this.nW[iLeft]  = this.nW[i2];
                this.nNE[iLeft] = this.nNE[i2];
                this.nSE[iLeft] = this.nSE[i2];
                this.nNW[iLeft] = this.nNW[i2];
                this.nSW[iLeft] = this.nSW[i2];
            }
        }

        // Free-slip top/bottom
        for (let x = 0; x < this.xdim; x++) {
            const iTop = x + (this.ydim - 1) * this.xdim;
            const i2   = x + (this.ydim - 2) * this.xdim;
            this.n0[iTop]  = this.n0[i2];
            this.nE[iTop]  = this.nE[i2];
            this.nW[iTop]  = this.nW[i2];
            this.nN[iTop]  = this.nN[i2];
            this.nS[iTop]  = this.nS[i2];
            this.nNE[iTop] = this.nNE[i2];
            this.nNW[iTop] = this.nNW[i2];
            this.nSE[iTop] = this.nSE[i2];
            this.nSW[iTop] = this.nSW[i2];
        }
        for (let x = 0; x < this.xdim; x++) {
            const iBot = x + 0 * this.xdim;
            const i2   = x + 1 * this.xdim;
            this.n0[iBot]  = this.n0[i2];
            this.nE[iBot]  = this.nE[i2];
            this.nW[iBot]  = this.nW[i2];
            this.nN[iBot]  = this.nN[i2];
            this.nS[iBot]  = this.nS[i2];
            this.nNE[iBot] = this.nNE[i2];
            this.nNW[iBot] = this.nNW[i2];
            this.nSE[iBot] = this.nSE[i2];
            this.nSW[iBot] = this.nSW[i2];
        }
    }

    collide() {
        const omega = 1 / (3 * this.viscosity + 0.5);

        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue;

                const thisrho =
                    this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + this.nW[i] +
                    this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];

                const thisux =
                    (this.nE[i] + this.nNE[i] + this.nSE[i]) -
                    (this.nW[i] + this.nNW[i] + this.nSW[i]);

                const thisuy =
                    (this.nN[i] + this.nNE[i] + this.nNW[i]) -
                    (this.nS[i] + this.nSE[i] + this.nSW[i]);

                const ux = thisux / thisrho;
                const uy = thisuy / thisrho;
                this.rho[i] = thisrho;
                this.ux[i]  = ux;
                this.uy[i]  = uy;

                const one9thrho  = this.one9th  * thisrho;
                const one36thrho = this.one36th * thisrho;
                const ux3 = 3 * ux;
                const uy3 = 3 * uy;
                const ux2 = ux * ux;
                const uy2 = uy * uy;
                const uxuy2 = 2 * ux * uy;
                const u2 = ux2 + uy2;
                const u215 = 1.5 * u2;

                this.n0[i]  += omega * (this.four9ths * thisrho * (1 - u215) - this.n0[i]);
                this.nE[i]  += omega * (one9thrho * (1 + ux3 + 4.5*ux2 - u215) - this.nE[i]);
                this.nW[i]  += omega * (one9thrho * (1 - ux3 + 4.5*ux2 - u215) - this.nW[i]);
                this.nN[i]  += omega * (one9thrho * (1 + uy3 + 4.5*uy2 - u215) - this.nN[i]);
                this.nS[i]  += omega * (one9thrho * (1 - uy3 + 4.5*uy2 - u215) - this.nS[i]);
                this.nNE[i] += omega * (one36thrho * (1 + ux3 + uy3 + 4.5*(u2 + uxuy2) - u215) - this.nNE[i]);
                this.nSE[i] += omega * (one36thrho * (1 + ux3 - uy3 + 4.5*(u2 - uxuy2) - u215) - this.nSE[i]);
                this.nNW[i] += omega * (one36thrho * (1 - ux3 + uy3 + 4.5*(u2 - uxuy2) - u215) - this.nNW[i]);
                this.nSW[i] += omega * (one36thrho * (1 - ux3 - uy3 + 4.5*(u2 + uxuy2) - u215) - this.nSW[i]);
            }
        }
    }

    stream() {
        // Stream north-moving
        for (let y = this.ydim - 2; y > 0; y--) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nN[x + y*this.xdim]  = this.nN[x + (y-1)*this.xdim];
                this.nNW[x + y*this.xdim] = this.nNW[x + 1 + (y-1)*this.xdim];
                this.nNE[x + y*this.xdim] = this.nNE[x - 1 + (y-1)*this.xdim];
            }
        }
        // Stream south-moving
        for (let y = 0; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nS[x + y*this.xdim]  = this.nS[x + (y+1)*this.xdim];
                this.nSW[x + y*this.xdim] = this.nSW[x + 1 + (y+1)*this.xdim];
                this.nSE[x + y*this.xdim] = this.nSE[x - 1 + (y+1)*this.xdim];
            }
        }
        // Bounce-back from barriers
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                if (this.barriers[x + y*this.xdim]) {
                    const i = x + y*this.xdim;
                    [this.nE[x+1 + y*this.xdim], this.nW[i]] = [this.nW[i], this.nE[i]];
                    [this.nN[x + (y+1)*this.xdim], this.nS[i]] = [this.nS[i], this.nN[i]];
                    [this.nNE[x+1 + (y+1)*this.xdim], this.nSW[i]] = [this.nSW[i], this.nNE[i]];
                    [this.nNW[x-1 + (y+1)*this.xdim], this.nSE[i]] = [this.nSE[i], this.nNW[i]];
                }
            }
        }
    }

    /**
     * computeSpeed: fill this.speed[] with sqrt(ux^2 + uy^2).
     */
    computeSpeed() {
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                const vx = this.ux[i];
                const vy = this.uy[i];
                this.speed[i] = Math.sqrt(vx*vx + vy*vy);
            }
        }
    }

    /**
     * draw: color by velocity magnitude instead of curl
     */
    draw() {
        this.computeSpeed(); // or could do on the fly

        // scale factor for speed -> color index
        const scale = 2000; // adjust as needed

        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                
                if (this.barriers[i]) {
                    // barrier in white
                    this.fillSquare(x, y, 255, 255, 255);
                    continue;
                }

                const spd = this.speed[i];
                let colorIndex = Math.floor(spd * scale);
                // clamp to [0, nColors-1]
                colorIndex = Math.max(0, Math.min(this.nColors - 1, colorIndex));

                const c = this.colors[colorIndex];
                this.fillSquare(x, y, c.r, c.g, c.b);
            }
        }
        this.ctx.putImageData(this.imageData, 0, 0);
    }

    fillSquare(x, y, r, g, b) {
        const flippedY = this.ydim - y - 1;
        for (let py = flippedY * this.pxPerSquare; py < (flippedY + 1) * this.pxPerSquare; py++) {
            for (let px = x * this.pxPerSquare; px < (x + 1) * this.pxPerSquare; px++) {
                const idx = (px + py * this.width) * 4;
                this.imageData.data[idx]   = r;
                this.imageData.data[idx+1] = g;
                this.imageData.data[idx+2] = b;
                this.imageData.data[idx+3] = 255;
            }
        }
    }

    update() {
        if (!this.running) return;

        const stepsPerFrame = 10;
        for (let step = 0; step < stepsPerFrame; step++) {
            this.setBoundaryConditions();
            this.collide();
            this.stream();
        }

        this.draw();
        requestAnimationFrame(() => this.update());
    }

    resize(width, height) {
        this.canvas.width = Math.max(width, 600);
        this.canvas.height = Math.max(height, 400);
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        this.initArrays();
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/3.5,
            thickness: 0.12,
            angle: 6.17
        });

        this.draw();
    }
}

// Initialize with improved event handling
document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.home-image');
    if (!container) {
        console.error("No .home-image found");
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'black';
    container.innerHTML = '';
    
    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.style.position = 'absolute';
    controlsDiv.style.bottom = '20px';
    controlsDiv.style.right = '20px';
    controlsDiv.style.backgroundColor = 'rgba(105, 193, 255, 0.9)';
    controlsDiv.style.padding = '10px';
    controlsDiv.style.borderRadius = '5px';
    controlsDiv.style.zIndex = '1000';  // Ensure controls are above the canvas
    controlsDiv.style.cursor = 'default';
    controlsDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 10px;">
            <strong>Airfoil Angle</strong>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
            <button id="decreaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↑</button>
            <div id="angleDisplay" style="font-family: monospace; min-width: 80px; text-align: center;"></div>
            <button id="increaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↓</button>
        </div>
    `;
    
    container.appendChild(canvas);
    container.appendChild(controlsDiv);

    const rect = container.getBoundingClientRect();
    canvas.width = Math.max(Math.floor(rect.width), 600);
    canvas.height = Math.max(Math.floor(rect.height), 400);

    // Create simulation with improved parameters
    const simulation = new FluidSimulation(canvas, {
        pxPerSquare: 2,
        flowSpeed: 0.2,
        flowAngleDeg: 0,
        viscosity: .3
    });

    // Set up angle control handlers
    const stepSize = 0.05; // About 2.86 degrees
    const angleDisplay = document.getElementById('angleDisplay');
    const updateAngleDisplay = () => {
        const degrees = (simulation.currentAngle * 180 / Math.PI).toFixed(1);
        const radians = simulation.currentAngle.toFixed(2);
        angleDisplay.innerHTML = `${radians} rad<br>${degrees}°`;
    };
    updateAngleDisplay();

    document.getElementById('increaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle + stepSize);
        updateAngleDisplay();
    });

    document.getElementById('decreaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle - stepSize);
        updateAngleDisplay();
    });

    // Debounced resize handler
    let resizeTimeout;
    window.addEventListener('resize', () => {
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
            const r = container.getBoundingClientRect();
            simulation.resize(Math.floor(r.width), Math.floor(r.height));
        }, 250);
    });
});