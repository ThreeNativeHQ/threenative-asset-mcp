import { describe, expect, it } from "vitest";

import { CUE4PARSE_PATCH, CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";

// PRD-583: the conventional UE5.0-5.5 UAnimDataModel bone-track reader and the malformed-map rejection.
// The reader is C# compiled against the pinned CUE4Parse in a serialized native arm; until then these
// assertions pin the shipped source so a later edit cannot silently drop the reader or reintroduce the
// silent rest-pose fallback for an unmapped raw track.
describe("PRD-583 conventional UAnimDataModel reader", () => {
  it("ships in the converter revision that carries the data-model reader", () => {
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.84-animation");
  });

  it("reads the exact UAnimDataModel's own bone tracks into the existing bone-indexed route", () => {
    expect(CUE4PARSE_PROGRAM).toContain("bool PopulateFromDataModel(UAnimSequence sequence, IPackage package, out string reason)");
    expect(CUE4PARSE_PROGRAM).toContain('model.TryGetValue<FStructFallback[]>(out var tracks, "BoneAnimationTracks")');
    expect(CUE4PARSE_PROGRAM).toContain("sequence.RawAnimationData = data.ToArray();");
    expect(CUE4PARSE_PROGRAM).toContain("sequence.TrackToSkeletonMapTable = map.ToArray();");
    // Rational timing from the model's own NumberOfFrames and FrameRate, not a frames-per-second guess.
    expect(CUE4PARSE_PROGRAM).toContain("sequence.SequenceLength = (float) (numberOfFrames * (double) denominator / numerator);");
    // The exact model is the clip's own property or the editor-created export whose Outer is the clip,
    // never the first export whose type merely contains "DataModel".
    expect(CUE4PARSE_PROGRAM).toContain("static UObject? ExactDataModel(UAnimSequence sequence, IPackage package)");
    expect(CUE4PARSE_PROGRAM).toContain("string.Equals(export.Outer?.Name.Text, sequence.Name, StringComparison.Ordinal)");
    expect(CUE4PARSE_PROGRAM).toContain('static bool IsConventionalDataModel(UObject export) => export.ExportType is "AnimDataModel" or "UAnimDataModel";');
  });

  it("decodes both the native and the tagged FRawAnimSequenceTrack layouts", () => {
    expect(CUE4PARSE_PATCH).toContain("FUE5ReleaseStreamObjectVersion.Type.RawAnimSequenceTrackSerializer");
    expect(CUE4PARSE_PATCH).toContain("public FRawAnimSequenceTrack(FVector[] posKeys, FQuat[] rotKeys, FVector[] scaleKeys)");
    expect(CUE4PARSE_PROGRAM).toContain("static bool ModelTrackData(FStructFallback track, out FRawAnimSequenceTrack raw, out string reason)");
    expect(CUE4PARSE_PROGRAM).toContain('track.TryGetValue<FStructFallback>(out var tagged, "InternalTrackData")');
  });

  it("rejects a malformed or unmapped raw track map instead of leaving the rest pose", () => {
    // The converter no longer keeps the rest pose for a raw track whose map is empty, out of range or
    // ambiguous; it throws a precise reason the adapter catches per clip.
    expect(CUE4PARSE_PATCH).toContain("but no track-to-bone map");
    expect(CUE4PARSE_PATCH).toContain("entries for");
    expect(CUE4PARSE_PATCH).toContain("outside the skeleton's {numBones} bones");
    expect(CUE4PARSE_PATCH).toContain("maps more than one track to bone");
    expect(CUE4PARSE_PATCH).not.toContain("if (trackIndex >= 0 && trackIndex < rawData.Length)");
    expect(CUE4PARSE_PATCH).toContain("throw new InvalidDataException");
    // A missing BoneTreeIndex is INDEX_NONE, not bone 0.
    expect(CUE4PARSE_PATCH).toContain("boneTreeIndex = -1");
    // The data-model reader also names each malformed case before it installs anything.
    expect(CUE4PARSE_PROGRAM).toContain("carries no BoneTreeIndex");
    expect(CUE4PARSE_PROGRAM).toContain("maps more than one track to bone {boneIndex}");
    expect(CUE4PARSE_PROGRAM).toContain("carries no keys");
  });

  it("keeps an unknown Sequencer/ControlRig model explicitly unsupported", () => {
    expect(CUE4PARSE_PROGRAM).toContain("ControlRig/Sequencer MovieScene model the importer does not evaluate");
    expect(CUE4PARSE_PROGRAM).toContain("the clip's {model.ExportType} bone tracks could not be read");
  });
});
