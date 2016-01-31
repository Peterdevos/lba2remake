import {Face3} from 'three';

export default class TriangleFace {
    constructor(axis, direction) {
        this.axis = axis;
        this.direction = direction;
    }

    key() {
        return `rect_${this.axis}${this.direction}`;
    }

    reverse() {
        return new TriangleFace(this.axis, 1 - this.direction);
    }

    hasVertex(vertex) {
        return vertex[this.axis] == this.direction * 2 - 1;
    }

    build(faces, indices) {
        if (this.direction == this.axis % 2)
            faces.push(new Face3(indices[0], indices[1], indices[2]));
        else
            faces.push(new Face3(indices[0], indices[2], indices[1]));
    }
}
