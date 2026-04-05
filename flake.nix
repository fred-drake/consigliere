{
  description = "Consigliere - Command execution bridge for Claude Cowork";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_22
            docker
            docker-compose
            gh
          ];

          shellHook = ''
            echo "consigliere dev shell loaded"
            echo "bun $(bun --version)"
          '';
        };
      }
    );
}
