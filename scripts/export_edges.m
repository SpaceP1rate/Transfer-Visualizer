function export_edges(edges_dir, out_dir, n_impulse, K)
% EXPORT_EDGES  Reduce a folder of edge_*.mat solution files to the compact CSV
% the visualizer loads.
%
%   export_edges('edges_L1_Halo_to_L2_Halo')
%   export_edges('edges_L1_Halo_to_L2_Halo', 'site_data', 2, 3)
%
% A full run keeps every converged multistart solution: 625 seeds x 60 TOF
% slices x 100 pairings is of order a million rows per family pair, which is far
% too much to commit to a static site. What the visualization actually needs is
% the delta-V surface — the best solution at each (departure, arrival, TOF) —
% plus enough of the runners-up to show where the solver found genuinely
% distinct branches rather than one basin.
%
% So for each (pairing, TOF slice) this keeps:
%   rank 1      the minimum-delta-V solution
%   rank 2..K   the next best solutions that are *distinct* from all better
%               ones, where distinct means the first burn points in a
%               noticeably different direction or costs noticeably more
% and records how many seeds converged at that slice, so the density of the
% multistart is still visible in the UI without shipping it.
%
% Output: <out_dir>/transfers_<DEP>_to_<ARR>_n<k>.csv
%         columns match the reader in src/lib/csv.js.

if nargin < 2 || isempty(out_dir);   out_dir   = 'site_data'; end
if nargin < 3 || isempty(n_impulse); n_impulse = 2;           end
if nargin < 4 || isempty(K);         K         = 3;           end

% Two solutions count as the same branch when their first burns agree this
% closely in direction (radians) and in magnitude (relative).
ANGLE_TOL = 0.15;
MAG_TOL   = 0.02;

if ~exist(edges_dir, 'dir')
    error('export_edges:noDir', 'not a directory: %s', edges_dir);
end
if ~exist(out_dir, 'dir'); mkdir(out_dir); end

files = dir(fullfile(edges_dir, 'edge_*.mat'));
if isempty(files)
    error('export_edges:noFiles', 'no edge_*.mat in %s', edges_dir);
end
fprintf('%s: %d pairing files\n', edges_dir, numel(files));

rows = table();
dep_family = ''; arr_family = '';

for f = 1:numel(files)
    S = load(fullfile(files(f).folder, files(f).name));
    T = S.edge_table;
    if isempty(T); continue; end

    if isempty(dep_family)
        dep_family = regexprep(T.From{1}, '_\d+$', '');
        arr_family = regexprep(T.To{1},   '_\d+$', '');
    end

    % TOF_idx labels the shared TOF grid slice; fall back to the TOF value
    % itself if an older run did not record the index.
    if ismember('TOF_idx', T.Properties.VariableNames)
        slices = T.TOF_idx;
    else
        [~, ~, slices] = unique(round(T.TOF, 10));
    end

    for k = reshape(unique(slices), 1, [])
        sub = T(slices == k, :);
        n_conv = height(sub);
        [~, order] = sort(sub.DV_total, 'ascend');
        sub = sub(order, :);

        kept = sub(1, :);                 % rank 1: the best solution
        kept_dv1 = [sub.DV1_x(1), sub.DV1_y(1), sub.DV1_z(1)];
        ranks = 1;

        for i = 2:height(sub)
            if numel(ranks) >= K; break; end
            v = [sub.DV1_x(i), sub.DV1_y(i), sub.DV1_z(i)];
            if is_distinct(v, kept_dv1, ANGLE_TOL, MAG_TOL)
                kept = [kept; sub(i, :)];  %#ok<AGROW>
                kept_dv1 = [kept_dv1; v];  %#ok<AGROW>
                ranks(end+1) = numel(ranks) + 1; %#ok<AGROW>
            end
        end

        kept.Rank            = ranks(:);
        kept.Seeds_Converged = repmat(n_conv, height(kept), 1);
        kept.N_Impulse       = repmat(n_impulse, height(kept), 1);
        rows = [rows; kept];  %#ok<AGROW>
    end

    if mod(f, 10) == 0 || f == numel(files)
        fprintf('  %3d/%d files, %d rows kept\n', f, numel(files), height(rows));
    end
end

if isempty(rows); error('export_edges:empty', 'nothing converged'); end

% --- rename into the schema the site reads ------------------------------
out = table();
out.dep_orbit_id     = rows.From;
out.arr_orbit_id     = rows.To;
out.n_impulse        = rows.N_Impulse;
out.TOF              = rows.TOF;
out.DV_total         = rows.DV_total;
out.departure_phase  = rows.Departure_Phase;
out.arrival_phase    = rows.Arrival_Phase;
out.dv1_x            = rows.DV1_x;
out.dv1_y            = rows.DV1_y;
out.dv1_z            = rows.DV1_z;
out.dv2_x            = rows.DV2_x;
out.dv2_y            = rows.DV2_y;
out.dv2_z            = rows.DV2_z;
out.dv1_mag          = vecnorm([rows.DV1_x, rows.DV1_y, rows.DV1_z], 2, 2);
out.dv2_mag          = vecnorm([rows.DV2_x, rows.DV2_y, rows.DV2_z], 2, 2);
out.t_leg1           = rows.TOF;
out.min_moon_dist    = rows.Min_Moon_Dist;
out.lunar_valid      = rows.Lunar_Valid;
out.chain_id         = rows.Chain_ID;
out.position_residual = rows.Position_Residual;
if ismember('TOF_idx', rows.Properties.VariableNames)
    out.tof_idx = rows.TOF_idx;
end
if ismember('Delta_C', rows.Properties.VariableNames)
    out.delta_C = rows.Delta_C;
end
out.rank             = rows.Rank;
out.seeds_converged  = rows.Seeds_Converged;

% For n > 2 the interior coast durations are needed too; a 3-impulse export
% should add t_leg1/t_leg2 from the solver's leg times rather than the copy of
% TOF written above.
name = sprintf('transfers_%s_to_%s_n%d.csv', dep_family, arr_family, n_impulse);
writetable(out, fullfile(out_dir, name));
fprintf('wrote %s  (%d rows)\n', fullfile(out_dir, name), height(out));

end

% ---------------------------------------------------------------------------
function tf = is_distinct(v, kept, angle_tol, mag_tol)
% A candidate is a new branch if it differs from every kept solution either in
% first-burn direction or in first-burn magnitude.
nv = norm(v);
tf = true;
for i = 1:size(kept, 1)
    w  = kept(i, :);
    nw = norm(w);
    if nv < eps || nw < eps
        same_dir = true;
    else
        ca = max(-1, min(1, dot(v, w) / (nv * nw)));
        same_dir = acos(ca) < angle_tol;
    end
    same_mag = abs(nv - nw) <= mag_tol * max(nv, nw);
    if same_dir && same_mag
        tf = false;
        return
    end
end
end
