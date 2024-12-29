class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Simulation size
        this.width = canvas.width;
        this.height = canvas.height;

        // Improved resolution - use 1 pixel per cell for better detail
        this.pxPerSquare = options.pxPerSquare || 1;
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        // LBM constants
        this.four9ths = 4.0 / 9.0;
        this.one9th = 1.0 / 9.0;
        this.one36th = 1.0 / 36.0;

        // Simulation parameters with improved defaults
        this.flowSpeed = options.flowSpeed || 0.1;
        this.flowAngle = (options.flowAngleDeg || 0) * Math.PI / 180;
        this.viscosity = options.viscosity || 0.002;
        this.running = true;

        // Create arrays
        this.initArrays();

        // ImageData for pixel manipulation
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        // Prepare colors with improved contrast
        this.initColors();

        // Initialize fluid
        this.initFluid();

        // Add airfoil barrier
        this.addNACABarrier({
            chordFraction: 1/6,
            thickness: 0.12,
            angle: 6.2
        });

        // Start simulation
        this.update();
    }

    initArrays() {
        const size = this.xdim * this.ydim;
        
        // Use Float32Array for better performance
        this.n0 = new Float32Array(size);
        this.nN = new Float32Array(size);
        this.nS = new Float32Array(size);
        this.nE = new Float32Array(size);
        this.nW = new Float32Array(size);
        this.nNE = new Float32Array(size);
        this.nSE = new Float32Array(size);
        this.nNW = new Float32Array(size);
        this.nSW = new Float32Array(size);
        
        this.rho = new Float32Array(size);
        this.ux = new Float32Array(size);
        this.uy = new Float32Array(size);
        this.curl = new Float32Array(size);
        
        this.barriers = new Uint8Array(size);
    }

    setBoundaryConditions() {
        // Set uniform flow conditions at all boundaries
        // This creates a "wind tunnel" effect where flow passes through freely
        
        // Top and bottom boundaries maintain horizontal flow
        for (let x = 0; x < this.xdim; x++) {
            this.setEquilibrium(x, 0, this.flowSpeed, 0, 1);          // Top boundary
            this.setEquilibrium(x, this.ydim-1, this.flowSpeed, 0, 1); // Bottom boundary
        }
        
        // Left (inlet) and right (outlet) boundaries
        for (let y = 1; y < this.ydim-1; y++) {
            this.setEquilibrium(0, y, this.flowSpeed, 0, 1);           // Left boundary (inlet)
            this.setEquilibrium(this.xdim-1, y, this.flowSpeed, 0, 1); // Right boundary (outlet)
        }
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

    initFluid() {
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);
        
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                this.setEquilibrium(x, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
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

        this.n0[i] = this.four9ths * rho * (1 - u215);
        this.nE[i] = this.one9th * rho * (1 + ux3 + 4.5*ux2 - u215);
        this.nW[i] = this.one9th * rho * (1 - ux3 + 4.5*ux2 - u215);
        this.nN[i] = this.one9th * rho * (1 + uy3 + 4.5*uy2 - u215);
        this.nS[i] = this.one9th * rho * (1 - uy3 + 4.5*uy2 - u215);
        this.nNE[i] = this.one36th * rho * (1 + ux3 + uy3 + 4.5*(u2+uxuy2) - u215);
        this.nSE[i] = this.one36th * rho * (1 + ux3 - uy3 + 4.5*(u2-uxuy2) - u215);
        this.nNW[i] = this.one36th * rho * (1 - ux3 + uy3 + 4.5*(u2-uxuy2) - u215);
        this.nSW[i] = this.one36th * rho * (1 - ux3 - uy3 + 4.5*(u2+uxuy2) - u215);

        this.rho[i] = rho;
        this.ux[i] = ux;
        this.uy[i] = uy;
    }

    addNACABarrier({ chordFraction = 1/6, thickness = 0.12, angle = 0 }) {
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
                this.barriers[idx] = true;
            }
        }
    }

    collide() {
        const omega = 1 / (3 * this.viscosity + 0.5);

        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue;

                const thisrho = this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + 
                               this.nW[i] + this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];
                
                const thisux = (this.nE[i] + this.nNE[i] + this.nSE[i] - 
                               this.nW[i] - this.nNW[i] - this.nSW[i]) / thisrho;
                
                const thisuy = (this.nN[i] + this.nNE[i] + this.nNW[i] - 
                               this.nS[i] - this.nSE[i] - this.nSW[i]) / thisrho;

                this.rho[i] = thisrho;
                this.ux[i] = thisux;
                this.uy[i] = thisuy;

                const one9thrho = this.one9th * thisrho;
                const one36thrho = this.one36th * thisrho;
                const ux3 = 3 * thisux;
                const uy3 = 3 * thisuy;
                const ux2 = thisux * thisux;
                const uy2 = thisuy * thisuy;
                const uxuy2 = 2 * thisux * thisuy;
                const u2 = ux2 + uy2;
                const u215 = 1.5 * u2;

                this.n0[i] += omega * (this.four9ths * thisrho * (1 - u215) - this.n0[i]);
                this.nE[i] += omega * (one9thrho * (1 + ux3 + 4.5*ux2 - u215) - this.nE[i]);
                this.nW[i] += omega * (one9thrho * (1 - ux3 + 4.5*ux2 - u215) - this.nW[i]);
                this.nN[i] += omega * (one9thrho * (1 + uy3 + 4.5*uy2 - u215) - this.nN[i]);
                this.nS[i] += omega * (one9thrho * (1 - uy3 + 4.5*uy2 - u215) - this.nS[i]);
                this.nNE[i] += omega * (one36thrho * (1 + ux3 + uy3 + 4.5*(u2+uxuy2) - u215) - this.nNE[i]);
                this.nSE[i] += omega * (one36thrho * (1 + ux3 - uy3 + 4.5*(u2-uxuy2) - u215) - this.nSE[i]);
                this.nNW[i] += omega * (one36thrho * (1 - ux3 + uy3 + 4.5*(u2-uxuy2) - u215) - this.nNW[i]);
                this.nSW[i] += omega * (one36thrho * (1 - ux3 - uy3 + 4.5*(u2+uxuy2) - u215) - this.nSW[i]);
            }
        }
    }

    stream() {
        // Stream north-moving particles
        for (let y = this.ydim - 2; y > 0; y--) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nN[x + y*this.xdim] = this.nN[x + (y-1)*this.xdim];
                this.nNW[x + y*this.xdim] = this.nNW[x + 1 + (y-1)*this.xdim];
                this.nNE[x + y*this.xdim] = this.nNE[x - 1 + (y-1)*this.xdim];
            }
        }

        // Stream south-moving particles
        for (let y = 0; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nS[x + y*this.xdim] = this.nS[x + (y+1)*this.xdim];
                this.nSW[x + y*this.xdim] = this.nSW[x + 1 + (y+1)*this.xdim];
                this.nSE[x + y*this.xdim] = this.nSE[x - 1 + (y+1)*this.xdim];
            }
        }

        // Handle bounce-back from barriers
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                if (this.barriers[x + y*this.xdim]) {
                    const i = x + y*this.xdim;
                    
                    // Swap pairs of opposite directions
                    [this.nE[x+1 + y*this.xdim], this.nW[i]] = [this.nW[i], this.nE[i]];
                    [this.nN[x + (y+1)*this.xdim], this.nS[i]] = [this.nS[i], this.nN[i]];
                    [this.nNE[x+1 + (y+1)*this.xdim], this.nSW[i]] = [this.nSW[i], this.nNE[i]];
                    [this.nNW[x-1 + (y+1)*this.xdim], this.nSE[i]] = [this.nSE[i], this.nNW[i]];
                }
            }
        }
    }

    computeCurl() {
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                this.curl[i] = 
                    (this.uy[x + 1 + y * this.xdim] - this.uy[x - 1 + y * this.xdim]) -
                    (this.ux[x + (y + 1) * this.xdim] - this.ux[x + (y - 1) * this.xdim]);
            }
        }
    }

    draw() {
        // Apply boundary conditions
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);

        // Set inlet conditions based on flow direction
        if (cosA > 0) {
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        } else {
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        }

        this.computeCurl();

        // Draw the fluid
        const contrast = 12;
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                
                if (this.barriers[i]) {
                    this.fillSquare(x, y, 255, 255, 255); // White for barriers
                    continue;
                }

                // Color based on curl
                let colorIndex = Math.floor((this.curl[i] * contrast + 0.5) * (this.nColors / 2));
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
                this.imageData.data[idx] = r;
                this.imageData.data[idx + 1] = g;
                this.imageData.data[idx + 2] = b;
                this.imageData.data[idx + 3] = 255;
            }
        }
    }

    update() {
        if (!this.running) return;

        // Perform multiple simulation steps per frame
        const stepsPerFrame = 20;
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

        // Maintain high resolution while resizing
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);

        this.initArrays();
        this.imageData = this.ctx.createImageData(this.width, this.height);
        
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/6,
            thickness: 0.12,
            angle: 6.2
        });
        this.draw();
    }
}

// Initialize with improved settings
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
    container.appendChild(canvas);

    const rect = container.getBoundingClientRect();
    canvas.width = Math.max(Math.floor(rect.width), 600);
    canvas.height = Math.max(Math.floor(rect.height), 400);

    // Create simulation with improved parameters
    const simulation = new FluidSimulation(canvas, {
        pxPerSquare: 2,       // Match original simulation's default resolution
        flowSpeed: 0.2,       // Similar to original simulation
        flowAngleDeg: 0,
        viscosity: .25      // Match original simulation's default viscosity
    });

    // Efficient resize handling
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const r = container.getBoundingClientRect();
            simulation.resize(Math.floor(r.width), Math.floor(r.height));
        }, 250);
    });
});