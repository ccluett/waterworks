// fluidSimulation.js  //

class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hasInitialized = false;
        this.options = options;
        this.currentAngle = -0.314159; 

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
        this.running = false;

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

        // 2) Add the airfoil barrier (polygon fill)
        this.addNACABarrier({
            chordFraction: 1/3,
            thickness: 0.12,
            angle: this.currentAngle
        });

        // 3) Start simulation
        this.draw();  // Draw the initial state regardless of running
        if (this.running) {
            this.update();
        }
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
        this.curl = new Float32Array(size);  

        this.speed = new Float32Array(size);

        this.barriers = new Uint8Array(size);
    }

    initFluid() {
        // Initialize entire domain to match inlet velocity and density
        const ux0 = this.flowSpeed * Math.cos(this.flowAngle);
        const uy0 = this.flowSpeed * Math.sin(this.flowAngle);
        const rho0 = 1.0;  // reference density
    
        // Set the entire domain to the inlet conditions
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                this.setEquilibrium(x, y, ux0, uy0, rho0);
            }
        }
    
        for (let i = 0; i < this.curl.length; i++) {
            this.curl[i] = 0.0;
        }

        // Zero out any velocities in barrier cells
        this._zeroOutBarrierCells();
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
                g = 0; 
                b = 0;
            }
            this.colors[i] = { r, g, b };
        }
    }

    computeDensity(i) {
        return this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + this.nW[i] + 
               this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];
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


     //  AIRFOIL GENERATION  // 

    addNACABarrier({ chordFraction = 1/3, thickness = 0.12, angle = 0 }) {
        const chordLength = Math.floor(this.xdim * chordFraction);
        const centerX = Math.floor(this.xdim / 3);
        const centerY = Math.floor(this.ydim / 2);

        // NACA thickness function
        const nacaThickness = (xFrac) => {
            return (thickness / 0.2) * chordLength * (
                0.2969 * Math.sqrt(xFrac) -
                0.1260 * xFrac -
                0.3516 * xFrac**2 +
                0.2843 * xFrac**3 -
                0.1015 * xFrac**4
            );
        };

        // 1) Generate top/bottom edges
        const { topPoints, botPoints } = this._generateAirfoilPoints(
            chordLength, centerX, centerY, angle, nacaThickness
        );

        // 2) Build a closed polygon
        const polygon = this._buildAirfoilPolygon(topPoints, botPoints);

        // 3) Fill polygon into this.barriers
        this._fillPolygon(polygon, this.barriers);

        // 4) Zero out fluid in all barrier cells
        this._zeroOutBarrierCells();
    }

     // Generate top & bottom edge points for chord slices
    _generateAirfoilPoints(chordLength, centerX, centerY, angle, thicknessFunc) {
        const cosAng = Math.cos(angle);
        const sinAng = Math.sin(angle);

        const topPoints = [];
        const botPoints = [];

        for (let i = 0; i <= chordLength; i++) {
            const xFrac = i / chordLength;
            const halfThick = thicknessFunc(xFrac);

            // mid-chord point
            const xMid = centerX + i * cosAng;
            const yMid = centerY + i * sinAng;

            // offset top & bottom
            const xTop = Math.round(xMid - halfThick * sinAng);
            const yTop = Math.round(yMid + halfThick * cosAng);
            const xBot = Math.round(xMid + halfThick * sinAng);
            const yBot = Math.round(yMid - halfThick * cosAng);

            topPoints.push({ x: xTop, y: yTop });
            botPoints.push({ x: xBot, y: yBot });
        }

        return { topPoints, botPoints };
    }

     // Create a single closed polygon from top & bottom edges
    _buildAirfoilPolygon(topPoints, botPoints) {
        // Reverse the bottom array so we get a continuous loop
        const reversedBot = botPoints.slice().reverse();
        // Combine them
        const polygon = topPoints.concat(reversedBot);
        return polygon;
    }

    
     // Fill the polygon via a simple scan-line approach
    _fillPolygon(polygon, barrierArray) {
        // 1. Find bounding box
        let minY = Infinity, maxY = -Infinity;
        for (const pt of polygon) {
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }
        // clamp to domain
        minY = Math.max(0, minY);
        maxY = Math.min(this.ydim - 1, maxY);

        // 2. For each y, find x-intersections
        for (let y = minY; y <= maxY; y++) {
            const xIntersections = [];
            for (let i = 0; i < polygon.length; i++) {
                const p1 = polygon[i];
                const p2 = polygon[(i+1) % polygon.length];
                // check if line (p1->p2) crosses horizontal line at y
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    const dy = p2.y - p1.y;
                    const t = (y - p1.y) / dy;
                    const xInt = p1.x + (p2.x - p1.x) * t;
                    xIntersections.push(Math.round(xInt));
                }
            }
            xIntersections.sort((a,b)=>a-b);

            // 3. fill pairs of intersections
            for (let k = 0; k < xIntersections.length - 1; k += 2) {
                const xStart = xIntersections[k];
                const xEnd   = xIntersections[k+1];
                for (let x = xStart; x <= xEnd; x++) {
                    if (x >= 0 && x < this.xdim) {
                        barrierArray[x + y*this.xdim] = 1;
                    }
                }
            }
        }
    }

     // Zero out fluid in barrier cells
    _zeroOutBarrierCells() {
        for (let i = 0; i < this.barriers.length; i++) {
            if (this.barriers[i] === 1) {
                this.n0[i]  = 0;  
                this.nN[i]  = 0;  
                this.nS[i]  = 0;
                this.nE[i]  = 0;  
                this.nW[i]  = 0;  
                this.nNE[i] = 0;
                this.nSE[i] = 0;  
                this.nNW[i] = 0;  
                this.nSW[i] = 0;

                this.rho[i] = 0; 
                this.ux[i]  = 0;  
                this.uy[i]  = 0;
            }
        }
    }

    setBoundaryConditions() {
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);
    
        // Handle both inlet and outlet with consistent velocity
        if (cosA >= 0) {
            // Left to right flow
            for (let y = 0; y < this.ydim; y++) {
                // Left boundary (inlet) - fixed density
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
                
                // Right boundary (outlet) - maintain velocity but let density adjust
                const i2 = (this.xdim - 2) + y * this.xdim;
                const rhoOut = this.computeDensity(i2);
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, rhoOut);
            }
        } else {
            // Right to left flow
            for (let y = 0; y < this.ydim; y++) {
                // Right boundary (inlet) - fixed density
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
                
                // Left boundary (outlet) - maintain velocity but let density adjust
                const i2 = 1 + y * this.xdim;
                const rhoOut = this.computeDensity(i2);
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, rhoOut);
            }
        }
    
        // Free-slip top/bottom boundaries
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

    computeCurl() {
        // Compute curl (vorticity) as ∂uy/∂x - ∂ux/∂y using central differences
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                
                // Central difference for ∂uy/∂x
                const duy_dx = (this.uy[x + 1 + y * this.xdim] - this.uy[x - 1 + y * this.xdim]) / 2.0;
                
                // Central difference for ∂ux/∂y
                const dux_dy = (this.ux[x + (y + 1) * this.xdim] - this.ux[x + (y - 1) * this.xdim]) / 2.0;
                
                this.curl[i] = duy_dx - dux_dy;
            }
        }
    }

    // draw() {
    //     // Compute curl before drawing
    //     this.computeCurl();
    
    //     const scale = 100.0;  // Adjust this to change curl color sensitivity
    //     for (let y = 0; y < this.ydim; y++) {
    //         for (let x = 0; x < this.xdim; x++) {
    //             const i = x + y * this.xdim;
                
    //             if (this.barriers[i]) {
    //                 // barrier in white
    //                 this.fillSquare(x, y, 255, 255, 255);
    //                 continue;
    //             }
    
    //             // Map curl to color index
    //             let colorIndex = Math.floor((this.curl[i] * scale + 0.5) * this.nColors);
    //             colorIndex = Math.max(0, Math.min(this.nColors - 1, colorIndex));
    
    //             const c = this.colors[colorIndex];
    //             this.fillSquare(x, y, c.r, c.g, c.b);
    //         }
    //     }
    //     // Put the simulation pixels onto the canvas
    //     this.ctx.putImageData(this.imageData, 0, 0);
    // }


    draw() {
        this.computeSpeed();
    
        const scale = 1200;  // same as your velocity->color indexing
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
                colorIndex = Math.max(0, Math.min(this.nColors - 1, colorIndex));
    
                const c = this.colors[colorIndex];
                this.fillSquare(x, y, c.r, c.g, c.b);
            }
        }
        // Put the simulation pixels onto the canvas
        this.ctx.putImageData(this.imageData, 0, 0);
    
        // Add horizontal legend at the bottom left
        // this.drawLegend(scale);
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

        const stepsPerFrame = 5;
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
            chordFraction: 1/6,
            thickness: 0.12,
            angle: 0
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
    canvas.className = 'simulation-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'black';
    container.innerHTML = '';
    
    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'simulation-controls'; // Add this line
    controlsDiv.style.position = 'absolute';
    controlsDiv.style.bottom = '20px';
    controlsDiv.style.right = '20px';
    controlsDiv.style.backgroundColor = 'rgba(105, 193, 255, 0.9)';
    controlsDiv.style.padding = '10px';
    controlsDiv.style.borderRadius = '5px';
    controlsDiv.style.zIndex = '1000'; 
    controlsDiv.style.cursor = 'default';
    controlsDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 10px;">
            <button id="playPauseButton" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white; margin-bottom: 0px;">
                Simulate
            </button>
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
    
    canvas.classList.add('initialized');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const controls = document.querySelector('.simulation-controls');
            if (entry.isIntersecting) {
                controls.style.opacity = '1';
                controls.style.visibility = 'visible';
            } else {
                controls.style.opacity = '0';
                controls.style.visibility = 'hidden';
            }
        });
    }, { threshold: 0.1 });
    
    observer.observe(canvas);

    // Set up angle control handlers
    const stepSize = 0.0349066; // 2 degrees
    const angleDisplay = document.getElementById('angleDisplay');
    const updateAngleDisplay = () => {
        const degrees = (simulation.currentAngle * 180 / Math.PI).toFixed(1);
        const radians = simulation.currentAngle.toFixed(2);
        //angleDisplay.innerHTML = `${radians*-1} rad<br>${degrees*-1}°`;
        angleDisplay.innerHTML = `Adjust AoA<br>${degrees*-1}°`;
    };
    updateAngleDisplay();

    document.getElementById('increaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle + stepSize);
        updateAngleDisplay();
        if (!simulation.running) {
            simulation.running = true;
            simulation.update();
            document.getElementById('playPauseButton').textContent = 'Pause';
        }
    });
    
    document.getElementById('decreaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle - stepSize);
        updateAngleDisplay();
        if (!simulation.running) {
            simulation.running = true;
            simulation.update();
            document.getElementById('playPauseButton').textContent = 'Pause';
        }
    });

    // Play/pause event listener
    document.getElementById('playPauseButton').addEventListener('click', () => {
        simulation.running = !simulation.running;
        const button = document.getElementById('playPauseButton');
        button.textContent = simulation.running ? 'Pause' : 'Simulate';
        if (simulation.running) {
            simulation.update();
        }
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