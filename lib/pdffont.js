'use strict';

let nodeUtil = require("util"),
    _ = require("lodash"),
    PDFUnit = require('./pdfunit.js');

const SystemFonts = require('system-font-families').default;
const opentype = require('opentype.js');
const FONTS = {};
const systemFonts = new SystemFonts();

// chargement des fonts du sys�me.
console.log("system fonts:");
for (let font of systemFonts.getFontsExtendedSync()) {
    for(let [style, name] of Object.entries(font.postscriptNames)) {
        FONTS[name] = { 
            style,
            filepath: font.files[style],
            opentype: null
        };
        console.log(name);
    }
}
console.log("system fonts completed.");

const getFont = (postscriptName) => {
    console.log("getFont", postscriptName);
    const font = FONTS[postscriptName] || FONTS["ArialMT"];
    if (!font.opentype) font.opentype = opentype.loadSync(font.filepath);
    return font;
}

let PDFFont = (function PFPFontClosure() {
    // private static
    let _nextId = 1;
    let _name = 'PDFFont';

    // constructor
    let cls = function (fontObj) {
        // private
        let _id = _nextId++;

        // public (every instance will have their own copy of these methods, needs to be lightweight)
        this.get_id = function () { return _id; };
        this.get_name = function () { return _name + _id; };

        this.fontObj = fontObj;
        
        const names = (fontObj.name || fontObj.fallbackName).split("+");
        if (names.length > 1) this.name = names[1];
        else this.name = names[0];

        const { opentype, filepath, style } = getFont();
        this.opentype = opentype;
        this.filepath = filepath;
        this.style = style;
    };

    // public static
    /** sort text blocks by y then x */
    const DISTANCE_DELTA = 0.1;
    cls.compareBlockPos = function (t1, t2) {
        if (t1.y < t2.y - DISTANCE_DELTA) {
            return -1;
        }
        if (Math.abs(t1.y - t2.y) <= DISTANCE_DELTA) {
            if (t1.x < t2.x - DISTANCE_DELTA) {
                return -1;
            }
            if (Math.abs(t1.x - t2.x) <= DISTANCE_DELTA) {
                return 0;
            }
        }
        return 1;
    };

    cls.getSpaceThreshHold = function (t1) {
        return (PDFFont.getFontSize(t1) / 12) * t1.sw;
    };

    cls.areAdjacentBlocks = function (t1, t2) {
        let isInSameLine = Math.abs(t1.y - t2.y) <= DISTANCE_DELTA;
        let isDistanceSmallerThanASpace = ((t2.x - t1.x - t1.w) < cls.getSpaceThreshHold(t1));

        return isInSameLine && isDistanceSmallerThanASpace;
    };

    cls.getFontSize = function (textBlock) {
        return textBlock.R[0].TS[0];
    };

    let _textRotationAngle = function (matrix2D) {
        let retVal = 0;
        if (matrix2D[0][0] === 0 && matrix2D[1][1] === 0) {
            if (matrix2D[0][1] != 0 && matrix2D[1][0] != 0) {
                if ((matrix2D[0][1] / matrix2D[1][0]) + 1 < 0.0001)
                    retVal = 90;
            }
        }
        else if (matrix2D[0][0] !== 0 && matrix2D[1][1] !== 0) {
            let r1 = Math.atan(-matrix2D[0][1] / matrix2D[0][0]);
            let r2 = Math.atan(matrix2D[1][0] / matrix2D[1][1]);
            if (Math.abs(r1) > 0.0001 && (r1 - r2 < 0.0001)) {
                retVal = r1 * 180 / Math.PI;
            }
        }
        return retVal;
    };

    // https://developer.tizen.org/community/tip-tech/working-fonts-using-opentype.js?langswitch=en
    cls.prototype.measureText = function (text) {
        try {
            const { opentype, fontSize } = this;
            let ascent = 0;
            let descent = 0;
            let width = opentype.getAdvanceWidth(text, fontSize);

            let scale = 1 / opentype.unitsPerEm * fontSize;
            let glyphs = opentype.stringToGlyphs(text, opentype.defaultRenderOptions);
            for (let i = 0; i < glyphs.length; i++) {
                let glyph = glyphs[i];

                // if (glyph.advanceWidth) {
                //     width += glyph.advanceWidth * scale;
                // }
                
                if ("yMax" in glyph) ascent = Math.max(ascent, glyph.yMax);
                if ("yMin" in glyph) descent = Math.min(descent, glyph.yMin);
            }

            return {
                width: PDFUnit.toFormX(width),
                actualBoundingBoxAscent: PDFUnit.toFormX(ascent * scale),
                actualBoundingBoxDescent: PDFUnit.toFormX(descent * scale),
                fontBoundingBoxAscent: PDFUnit.toFormX(opentype.ascender * scale),
                fontBoundingBoxDescent: PDFUnit.toFormX(opentype.descender * scale)
            };
        } catch (error) {
            throw new Error(this.typeName, error);
        }
    }

    // public (every instance will share the same method, but has no access to private fields defined in constructor)
    cls.prototype.processText = function (p, str, maxWidth, color, fontSize, targetData, matrix2D) {
        console.log("processText", p, str, maxWidth, color, fontSize, targetData, matrix2D);
        let text = str;
        if (!text) {
            return;
        }
        text = text.trim();
        this.fontSize = fontSize;

        let TS = [fontSize, color];

        let clrId = PDFUnit.findColorIndex(color);

        const { width: spaceWidth } = this.measureText(" ");
        this.spaceWidth = PDFUnit.toFixedFloat(spaceWidth);

        const { width, actualBoundingBoxAscent, actualBoundingBoxDescent } = this.measureText(text);
        const height = actualBoundingBoxAscent - actualBoundingBoxDescent;
        
        let oneText = {
            x: PDFUnit.toFormX(p.x),
            y: PDFUnit.toFormY(p.y) - PDFUnit.toFixedFloat(actualBoundingBoxAscent),
            w: PDFUnit.toFixedFloat(width),
            h: PDFUnit.toFixedFloat(height),
            sw: this.spaceWidth, //font space width, use to merge adjacent text blocks
            clr: clrId,
            A: "left",
            R: [{
                T: text,
                F: this, //font
                TS: TS
            }]
        };

        //MQZ.07/29/2013: when color is not in color dictionary, set the original color (oc)
        if (clrId < 0) {
            oneText = _.extend({ oc: color }, oneText);
        }

        let rAngle = _textRotationAngle.call(this, matrix2D);
        if (rAngle != 0) {
            nodeUtil.p2jinfo(str + ": rotated " + rAngle + " degree.");
            _.extend(oneText.R[0], { RA: rAngle });
        }

        targetData.Texts.push(oneText);
    };

    cls.prototype.clean = function () {
        this.fontObj = null;
        delete this.fontObj;
    };

    return cls;
})();

module.exports = PDFFont;
