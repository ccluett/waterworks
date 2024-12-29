/*******************************************************
 * fluidSimulation.js
 * Example lattice-Boltzmann fluid simulation with
 * user-specified flow angle and rotated NACA barrier.
 ******************************************************/

class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Simulation size
        this.width = canvas.width;
        this.height = canvas.height;

        // Pixels per lattice cell
        this.pxPerSquare = options.pxPerSquare || 1;
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        // Basic LBM constants
        this.four9ths = 4.0 / 9.0;
        this.one9th = 1.0 / 9.0;
        this.one36th = 1.0 / 36.0;

        // Simulation parameters
        const angleDeg = (options.flowAngleDeg !== undefined) ? options.flowAngleDeg : 20;
        const angleRad = angleDeg * Math.PI / 180; // convert to radians
        this.flowAngle = angleRad;

        this.flowSpeed = options.flowSpeed || 0.2;
        this.viscosity = options.viscosity || 0.002;
        this.running = true;

        // Create arrays
        this.initArrays();

        // ImageData for direct pixel manipulation
        this.imageData = this.ctx.createImageData(this.width, this.height);

        // Prepare colors for plotting
        this.initColors();

        // Initialize fluid to uniform flow at the specified angle
        this.initFluid();

        // Add a rotated NACA airfoil barrier
        // (You can skip or replace with your own geometry.)
        this.addNACABarrier({
            chordFraction: 1/6,    // chord length ~ 1/6 of x-dim
            thickness: 0.12,       // 12% thickness for NACA 00xx
            angle: 0,              // rotate the airfoil around its chord
        });

        // Optionally rotate the entire barrier by some angle if desired:
        // this.rotateBarrierAroundCenter( Math.PI/4 );  // example 45 deg rotation

    }

    /****************************************************
     * 1. ARRAY ALLOCATIONS
     ****************************************************/
    initArrays() {
        const size = this.xdim * this.ydim;

        // Discrete distribution functions
        this.n0 = new Float32Array(size);
        this.nN = new Float32Array(size);
        this.nS = new Float32Array(size);
        this.nE = new Float32Array(size);
        this.nW = new Float32Array(size);
        this.nNE = new Float32Array(size);
        this.nSE = new Float32Array(size);
        this.nNW = new Float32Array(size);
        this.nSW = new Float32Array(size);

        // Macroscopic fields
        this.rho = new Float32Array(size);
        this.ux = new Float32Array(size);
        this.uy = new Float32Array(size);
        this.curl = new Float32Array(size);

        // Barrier mask
        this.barriers = new Array(size).fill(false);
    }

    /****************************************************
     * 2. INITIALIZE COLORS
     ****************************************************/
    initColors() {
        // Simple "jet-like" colormap
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
                b = Math.round(255 * (0.625 - phase) / 0.25);
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

    /****************************************************
     * 3. INITIALIZE FLUID
     *    Set the entire domain to uniform velocity
     *    with user-specified angle.
     ****************************************************/
    initFluid() {
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);

        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                // setEquilibrium(x, y, ux, uy, rho)
                this.setEquilibrium(
                    x, 
                    y, 
                    this.flowSpeed * cosA, 
                    this.flowSpeed * sinA, 
                    1
                );
            }
        }
    }

    /****************************************************
     * 4. BARRIER: NACA 00xx AIRFOIL, ROTATED
     ****************************************************/
    addNACABarrier({ chordFraction = 1/6, thickness = 0.12, angle = 0 }) {
        // We'll place the chord ~1/3 from left, centered vertically
        // by default, but angled by 'angle'.
        const chordLength = Math.floor(this.xdim * chordFraction);
        const centerX = Math.floor(this.xdim / 3);
        const centerY = Math.floor(this.ydim / 2);

        // A standard "NACA 00xx" thickness function
        // for 0 <= x <= chordLength in local coords
        const nacaThickness = (xFrac) => {
            // thickness distribution for NACA 00(100 * thickness):
            // t = thickness, e.g. 0.12 for NACA 0012
            // formula from the well-known polynomial approximation
            const t = thickness;
            return (t / 0.2) * chordLength *
                   (0.2969 * Math.sqrt(xFrac)
                    - 0.1260 * xFrac
                    - 0.3516 * xFrac**2
                    + 0.2843 * xFrac**3
                    - 0.1015 * xFrac**4);
        };

        // We’ll parametrize the chord from 0..1 in "airfoil space."
        // Then we rotate around angle. 
        const cosAng = Math.cos(angle);
        const sinAng = Math.sin(angle);

        for (let i = 0; i <= chordLength; i++) {
            const xFrac = i / chordLength;
            const halfThick = nacaThickness(xFrac);
            // local coords in "airfoil space":
            // chord along +X_local, thickness along ±Y_local
            // The mean line is Y_local=0
            // So top edge is (i, +halfThick), bottom edge is (i, -halfThick)

            // We'll rotate about the chord's starting point
            // or about chord's midpoint. Let's do about the
            // chord's starting point to keep it simpler:
            // (You could also shift to centerX + i, centerY, then rotate.)
            const xLocalTop = i;
            const yLocalTop = +halfThick;
            const xLocalBot = i;
            const yLocalBot = -halfThick;

            // Rotate them by "angle" in 2D, then shift to center
            const xTop = Math.round(
                centerX + xLocalTop * cosAng - yLocalTop * sinAng
            );
            const yTop = Math.round(
                centerY + xLocalTop * sinAng + yLocalTop * cosAng
            );
            const xBot = Math.round(
                centerX + xLocalBot * cosAng - yLocalBot * sinAng
            );
            const yBot = Math.round(
                centerY + xLocalBot * sinAng + yLocalBot * cosAng
            );

            // Fill barrier points between top/bot
            this.fillBarrierLine(xTop, yTop, xBot, yBot);
        }
    }

    /**
     * fillBarrierLine: Mark all integer points between (x1,y1) and (x2,y2).
     * A simple way is to step in Y or X.  Or use Bresenham’s line.  Here:
     */
    fillBarrierLine(x1, y1, x2, y2) {
        // We can simply ensure we fill the vertical range if it's mostly vertical,
        // or fill the horizontal range if it's mostly horizontal.
        // Or do a small "box fill" if we want thickness. For simplicity:
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

    /**
     * If you want to rotate the entire barrier array around the domain center
     * or some pivot, you can do something like:
     */
    rotateBarrierAroundCenter(radAngle) {
        const centerX = this.xdim / 2;
        const centerY = this.ydim / 2;

        // Collect existing barrier points
        const points = [];
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                if (this.barriers[x + y * this.xdim]) {
                    points.push({ x, y });
                }
            }
        }
        // Clear them
        this.barriers.fill(false);

        // Re-place them with rotation
        const cosA = Math.cos(radAngle);
        const sinA = Math.sin(radAngle);

        for (const p of points) {
            const xRel = p.x - centerX;
            const yRel = p.y - centerY;
            const xNew = Math.round(centerX + xRel * cosA - yRel * sinA);
            const yNew = Math.round(centerY + xRel * sinA + yRel * cosA);
            if (
                xNew >= 0 &&
                xNew < this.xdim &&
                yNew >= 0 &&
                yNew < this.ydim
            ) {
                this.barriers[xNew + yNew * this.xdim] = true;
            }
        }
    }

    /****************************************************
     * 5. SET EQUILIBRIUM FUNCTION
     ****************************************************/
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
        this.nE[i] = this.one9th * rho * (1 + ux3 + 4.5 * ux2 - u215);
        this.nW[i] = this.one9th * rho * (1 - ux3 + 4.5 * ux2 - u215);
        this.nN[i] = this.one9th * rho * (1 + uy3 + 4.5 * uy2 - u215);
        this.nS[i] = this.one9th * rho * (1 - uy3 + 4.5 * uy2 - u215);
        this.nNE[i] = this.one36th * rho * (1 + ux3 + uy3 + 4.5 * (u2 + uxuy2) - u215);
        this.nSE[i] = this.one36th * rho * (1 + ux3 - uy3 + 4.5 * (u2 - uxuy2) - u215);
        this.nNW[i] = this.one36th * rho * (1 - ux3 + uy3 + 4.5 * (u2 - uxuy2) - u215);
        this.nSW[i] = this.one36th * rho * (1 - ux3 - uy3 + 4.5 * (u2 + uxuy2) - u215);

        this.rho[i] = rho;
        this.ux[i] = ux;
        this.uy[i] = uy;
    }

    /****************************************************
     * 6. COLLISION (BGK)
     ****************************************************/
    collide() {
        const omega = 1 / (3 * this.viscosity + 0.5);

        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue; // skip barrier

                const thisRho =
                    this.n0[i] +
                    this.nN[i] +
                    this.nS[i] +
                    this.nE[i] +
                    this.nW[i] +
                    this.nNW[i] +
                    this.nNE[i] +
                    this.nSW[i] +
                    this.nSE[i];

                const thisUx =
                    (this.nE[i] + this.nNE[i] + this.nSE[i] -
                     this.nW[i] - this.nNW[i] - this.nSW[i]) / thisRho;

                const thisUy =
                    (this.nN[i] + this.nNE[i] + this.nNW[i] -
                     this.nS[i] - this.nSE[i] - this.nSW[i]) / thisRho;

                this.rho[i] = thisRho;
                this.ux[i] = thisUx;
                this.uy[i] = thisUy;

                // Compute equilibrium
                const one9thrho = this.one9th * thisRho;
                const one36thrho = this.one36th * thisRho;
                const ux3 = 3 * thisUx;
                const uy3 = 3 * thisUy;
                const ux2 = thisUx * thisUx;
                const uy2 = thisUy * thisUy;
                const uxuy2 = 2 * thisUx * thisUy;
                const u2 = ux2 + uy2;
                const u215 = 1.5 * u2;

                this.n0[i] += omega * (this.four9ths * thisRho * (1 - u215) - this.n0[i]);
                this.nE[i] += omega * (one9thrho * (1 + ux3 + 4.5 * ux2 - u215) - this.nE[i]);
                this.nW[i] += omega * (one9thrho * (1 - ux3 + 4.5 * ux2 - u215) - this.nW[i]);
                this.nN[i] += omega * (one9thrho * (1 + uy3 + 4.5 * uy2 - u215) - this.nN[i]);
                this.nS[i] += omega * (one9thrho * (1 - uy3 + 4.5 * uy2 - u215) - this.nS[i]);
                this.nNE[i] += omega * (
                    one36thrho * 
                    (1 + ux3 + uy3 + 4.5 * (u2 + uxuy2) - u215) -
                    this.nNE[i]
                );
                this.nSE[i] += omega * (
                    one36thrho * 
                    (1 + ux3 - uy3 + 4.5 * (u2 - uxuy2) - u215) -
                    this.nSE[i]
                );
                this.nNW[i] += omega * (
                    one36thrho * 
                    (1 - ux3 + uy3 + 4.5 * (u2 - uxuy2) - u215) -
                    this.nNW[i]
                );
                this.nSW[i] += omega * (
                    one36thrho * 
                    (1 - ux3 - uy3 + 4.5 * (u2 + uxuy2) - u215) -
                    this.nSW[i]
                );
            }
        }
    }

    /****************************************************
     * 7. STREAMING + BOUNCE-BACK
     ****************************************************/
    stream() {
        // Standard streaming
        // N moves up, NE moves up-right, etc.

        // Move N
        for (let y = this.ydim - 2; y > 0; y--) {
            for (let x = 0; x < this.xdim; x++) {
                this.nN[x + y * this.xdim] = this.nN[x + (y - 1) * this.xdim];
                this.nNW[x + y * this.xdim] = this.nNW[x + 1 + (y - 1) * this.xdim];
                this.nNE[x + y * this.xdim] = this.nNE[x - 1 + (y - 1) * this.xdim];
            }
        }
        // Move S
        for (let y = 0; y < this.ydim - 1; y++) {
            for (let x = 0; x < this.xdim; x++) {
                this.nS[x + y * this.xdim] = this.nS[x + (y + 1) * this.xdim];
                this.nSW[x + y * this.xdim] = this.nSW[x + 1 + (y + 1) * this.xdim];
                this.nSE[x + y * this.xdim] = this.nSE[x - 1 + (y + 1) * this.xdim];
            }
        }
        // Move E
        for (let x = this.xdim - 1; x > 0; x--) {
            for (let y = 0; y < this.ydim; y++) {
                this.nE[x + y * this.xdim] = this.nE[x - 1 + y * this.xdim];
            }
        }
        // Move W
        for (let x = 0; x < this.xdim - 1; x++) {
            for (let y = 0; y < this.ydim; y++) {
                this.nW[x + y * this.xdim] = this.nW[x + 1 + y * this.xdim];
            }
        }

        // Barrier bounce-back
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) {
                    // Bounce back pairs
                    this.nE[x + y * this.xdim] = this.nW[i];
                    this.nW[x + y * this.xdim] = this.nE[i];
                    this.nN[x + y * this.xdim] = this.nS[i];
                    this.nS[x + y * this.xdim] = this.nN[i];
                    this.nNE[x + y * this.xdim] = this.nSW[i];
                    this.nSW[x + y * this.xdim] = this.nNE[i];
                    this.nNW[x + y * this.xdim] = this.nSE[i];
                    this.nSE[x + y * this.xdim] = this.nNW[i];
                }
            }
        }
    }

    /****************************************************
     * 8. COMPUTE CURL (for color plotting)
     ****************************************************/
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

    /****************************************************
     * 9. DRAW FUNCTION
     *    9a. Boundary conditions at domain edges
     *    9b. Compute curl for color
     *    9c. Fill squares in imageData
     ****************************************************/
    draw() {
        // Apply boundary velocity only on the "inlet" edge,
        // let "outlet" flow out. For demonstration, we do a simplified approach:
        // We'll check the sign of cos(flowAngle) and sin(flowAngle).
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);

        // If cosA > 0, then left edge is inlet; if cosA < 0, right edge is inlet.
        if (cosA > 0) {
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        } else {
            for (let y = 0; y < this.ydim; y++) {
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        }
        // If sinA > 0, bottom is inlet; if sinA < 0, top is inlet.
        if (sinA > 0) {
            for (let x = 0; x < this.xdim; x++) {
                this.setEquilibrium(x, 0, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        } else {
            for (let x = 0; x < this.xdim; x++) {
                this.setEquilibrium(x, this.ydim - 1, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
            }
        }

        this.computeCurl();

        // Increase or decrease contrast to taste
        const contrast = 12;
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) {
                    // Barrier in white
                    this.fillSquare(x, y, 255, 255, 255);
                    continue;
                }
                let colorIndex = Math.floor(
                    (this.curl[i] * contrast + 0.5) * (this.nColors / 2)
                );
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

    /****************************************************
     * 10. MAIN UPDATE LOOP
     ****************************************************/
    update() {
        if (!this.running) return;

        // LBM steps
        this.collide();
        this.stream();
        this.draw();

        requestAnimationFrame(() => this.update());
    }

    /****************************************************
     * 11. RESIZE (Optional)
     ****************************************************/
    resize(width, height) {
        // Update canvas
        this.canvas.width = Math.max(width, 600);
        this.canvas.height = Math.max(height, 400);
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        // Recompute lattice dims
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);

        // Re-init arrays
        this.initArrays();
        this.imageData = this.ctx.createImageData(this.width, this.height);

        // Re-init fluid and barrier
        this.initFluid();
        // Example re-adding default barrier:
        // this.addNACABarrier({ chordFraction: 1/6, thickness: 0.12, angle: 0 });

        // Re-draw
        this.draw();
    }
}

// -------------------------------------------------------------
// Example usage: (replace your .home-image or DOM references)
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.home-image');
    if (!container) {
        console.error("No .home-image found");
        return;
    }

    // Create a canvas in that container
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'black';
    container.innerHTML = '';
    container.appendChild(canvas);

    // Set initial size
    const rect = container.getBoundingClientRect();
    canvas.width = Math.max(Math.floor(rect.width), 600);
    canvas.height = Math.max(Math.floor(rect.height), 400);

    // Create the simulation
    const simulation = new FluidSimulation(canvas, {
        pxPerSquare: 1,
        flowSpeed: 0.1,        // magnitude
        flowAngle: Math.PI/2,  // e.g. Pi/2 => bottom->top flow
        viscosity: 0.005
    });

    // Start
    simulation.update();

    // Optional: handle window resize with debouncing
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const r = container.getBoundingClientRect();
            const w = Math.max(Math.floor(r.width), 600);
            const h = Math.max(Math.floor(r.height), 400);
            simulation.resize(w, h);
        }, 250);
    });
});
