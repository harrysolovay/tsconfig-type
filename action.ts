import pkg from "./package.json";
import semver from "semver";

function main(): Promise<void> {
    const version = new semver.SemVer(pkg.version);
    const nextVersion = version.inc("minor");
    const nextVersionString = nextVersion.version;
    console.log(nextVersionString);
    return Promise.resolve<void>(undefined);
}

main();
